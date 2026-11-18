import crypto from 'node:crypto';
import WebSocket from 'ws';
import { log, errMsg } from '../core/logger.js';
import { sleep } from '../core/utils.js';

export type Level = [price: number, qty: number];
export interface OrderBook {
  bids: Level[]; // best first (desc)
  asks: Level[]; // best first (asc)
  updateId: number;
  receivedAt: number;
}

export interface SymbolFilters {
  stepSize: number;
  minQty: number;
  minNotional: number;
}

export interface FillResult {
  orderId: number;
  clientOrderId: string;
  status: string;
  executedBase: number;
  quoteAmount: number; // cumulative quote qty (gross)
  commissionQuote: number; // commission converted to quote where possible
  avgPrice: number;
}

/**
 * Live order book from Binance partial-depth stream with automatic reconnect
 * and staleness tracking. Callback fires on every update (100ms cadence).
 */
export class BinanceBookStream {
  book: OrderBook | null = null;
  private ws: WebSocket | null = null;
  private closed = false;
  private reconnectDelay = 500;
  private watchdog: NodeJS.Timeout | null = null;

  constructor(
    private wsUrl: string,
    private symbol: string,
    private onUpdate: (b: OrderBook) => void,
  ) {}

  start() {
    this.connect();
  }

  stop() {
    this.closed = true;
    if (this.watchdog) clearInterval(this.watchdog);
    this.ws?.terminate();
  }

  private connect() {
    const url = `${this.wsUrl}/${this.symbol.toLowerCase()}@depth20@100ms`;
    const ws = new WebSocket(url, { perMessageDeflate: false, handshakeTimeout: 5000 });
    this.ws = ws;
    let lastMsg = Date.now();

    ws.on('open', () => {
      log.info('binance ws connected', { symbol: this.symbol });
      this.reconnectDelay = 500;
    });
    ws.on('message', (raw) => {
      lastMsg = Date.now();
      try {
        const m = JSON.parse(raw.toString()) as { lastUpdateId: number; bids: string[][]; asks: string[][] };
        if (!m.bids || !m.asks) return;
        this.book = {
          bids: m.bids.map(([p, q]) => [Number(p), Number(q)]),
          asks: m.asks.map(([p, q]) => [Number(p), Number(q)]),
          updateId: m.lastUpdateId,
          receivedAt: lastMsg,
        };
        this.onUpdate(this.book);
      } catch (e) {
        log.warn('binance ws parse error', { err: errMsg(e) });
      }
    });
    ws.on('close', () => this.scheduleReconnect());
    ws.on('error', (e) => log.warn('binance ws error', { err: errMsg(e) }));

    // Silent-dead-socket protection: no data for 10s => reconnect.
    if (this.watchdog) clearInterval(this.watchdog);
    this.watchdog = setInterval(() => {
      if (Date.now() - lastMsg > 10_000 && ws.readyState === WebSocket.OPEN) {
        log.warn('binance ws silent, reconnecting');
        ws.terminate();
      }
    }, 2_000);
  }

  private scheduleReconnect() {
    this.book = null; // never trade on a book we can't trust
    if (this.closed) return;
    const d = this.reconnectDelay;
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, 10_000);
    log.warn('binance ws closed, reconnecting', { inMs: d });
    setTimeout(() => this.connect(), d);
  }
}

/** Minimal signed REST client — no heavy SDK, keep-alive via undici. */
export class BinanceRest {
  private timeOffset = 0;

  constructor(
    private baseUrl: string,
    private apiKey?: string,
    private apiSecret?: string,
  ) {}

  async syncTime() {
    const t0 = Date.now();
    const r = (await this.publicGet('/api/v3/time')) as { serverTime: number };
    const t1 = Date.now();
    this.timeOffset = r.serverTime - Math.round((t0 + t1) / 2);
    log.info('binance time synced', { offsetMs: this.timeOffset, rttMs: t1 - t0 });
  }

  async getFilters(symbol: string): Promise<SymbolFilters> {
    const r = (await this.publicGet(`/api/v3/exchangeInfo?symbol=${symbol}`)) as {
      symbols: { filters: Record<string, string>[] }[];
    };
    const f = r.symbols[0]?.filters ?? [];
    const lot = f.find((x) => x.filterType === 'LOT_SIZE');
    const notional = f.find((x) => x.filterType === 'NOTIONAL' || x.filterType === 'MIN_NOTIONAL');
    return {
      stepSize: Number(lot?.stepSize ?? '0.0001'),
      minQty: Number(lot?.minQty ?? '0'),
      minNotional: Number(notional?.minNotional ?? '0'),
    };
  }

  async getBalances(assets: string[]): Promise<Record<string, number>> {
    const r = (await this.signed('GET', '/api/v3/account', { omitZeroBalances: 'true' })) as {
      balances: { asset: string; free: string }[];
    };
    const out: Record<string, number> = {};
    for (const a of assets) out[a] = Number(r.balances.find((b) => b.asset === a)?.free ?? 0);
    return out;
  }

  /**
   * MARKET order with idempotent client id. If the request times out / network
   * fails we query the order by client id instead of blindly retrying (which
   * could double-fill).
   */
  async marketOrder(symbol: string, side: 'BUY' | 'SELL', quantity: string, quoteAsset: string): Promise<FillResult> {
    const clientOrderId = `arb_${Date.now().toString(36)}_${crypto.randomBytes(3).toString('hex')}`;
    const params = { symbol, side, type: 'MARKET', quantity, newClientOrderId: clientOrderId, newOrderRespType: 'FULL' };
    let res: any;
    try {
      res = await this.signed('POST', '/api/v3/order', params, 4000);
    } catch (e) {
      if (e instanceof BinanceApiError) throw e; // definitive rejection, order not placed
      log.warn('order request uncertain, querying status', { clientOrderId, err: errMsg(e) });
      res = await this.queryOrderWithRetry(symbol, clientOrderId);
    }
    return parseFill(res, quoteAsset);
  }

  private async queryOrderWithRetry(symbol: string, clientOrderId: string): Promise<any> {
    for (let i = 0; i < 6; i++) {
      try {
        return await this.signed('GET', '/api/v3/order', { symbol, origClientOrderId: clientOrderId });
      } catch (e) {
        if (e instanceof BinanceApiError && e.code === -2013) {
          // "Order does not exist" — may still be in flight right after a timeout
          if (i >= 3) throw new Error(`order ${clientOrderId} not found: not placed`);
        }
        await sleep(300 * (i + 1));
      }
    }
    throw new Error(`order ${clientOrderId} state unknown`);
  }

  private async publicGet(path: string): Promise<unknown> {
    const res = await fetch(this.baseUrl + path, { signal: AbortSignal.timeout(5000) });
    return handle(res);
  }

  private async signed(method: 'GET' | 'POST', path: string, params: Record<string, string>, timeoutMs = 5000) {
    if (!this.apiKey || !this.apiSecret) throw new Error('Binance API key/secret not configured');
    const qs = new URLSearchParams({ ...params, recvWindow: '5000', timestamp: String(Date.now() + this.timeOffset) });
    const sig = crypto.createHmac('sha256', this.apiSecret).update(qs.toString()).digest('hex');
    qs.append('signature', sig);
    const url = `${this.baseUrl}${path}?${qs.toString()}`;
    const res = await fetch(url, {
      method,
      headers: { 'X-MBX-APIKEY': this.apiKey },
      signal: AbortSignal.timeout(timeoutMs),
    });
    return handle(res);
  }
}

export class BinanceApiError extends Error {
  constructor(public code: number, msg: string, public httpStatus: number) {
    super(`Binance ${httpStatus} ${code}: ${msg}`);
  }
}

async function handle(res: Response): Promise<unknown> {
  const text = await res.text();
  let body: any;
  try {
    body = JSON.parse(text);
  } catch {
    body = { msg: text };
  }
  if (!res.ok) {
    // 5xx = unknown execution state on Binance => treat as network-uncertain (plain Error)
    if (res.status >= 500) throw new Error(`Binance ${res.status}: ${body?.msg ?? text}`);
    throw new BinanceApiError(body?.code ?? -1, body?.msg ?? text, res.status);
  }
  return body;
}

function parseFill(r: any, quoteAsset: string): FillResult {
  const executedBase = Number(r.executedQty ?? 0);
  const quoteAmount = Number(r.cummulativeQuoteQty ?? 0);
  let commissionQuote = 0;
  for (const f of r.fills ?? []) {
    const c = Number(f.commission);
    if (f.commissionAsset === quoteAsset) commissionQuote += c;
    else if (f.commissionAsset !== 'BNB') commissionQuote += c * Number(f.price); // paid in base
  }
  return {
    orderId: r.orderId,
    clientOrderId: r.clientOrderId,
    status: r.status,
    executedBase,
    quoteAmount,
    commissionQuote,
    avgPrice: executedBase > 0 ? quoteAmount / executedBase : 0,
  };
}
