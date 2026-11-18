import ccxt from 'ccxt';
import { Worker } from 'node:worker_threads';
import type { Address } from 'viem';
import { exchangeCreds, type AssetCfg, type ChainCfg } from '../config.js';
import { log, errMsg } from '../core/logger.js';
import { sleep } from '../core/utils.js';

export type Level = [number, number];
export interface Book { bids: Level[]; asks: Level[]; ts: number }

export interface NetInfo {
  network: string; // ccxt unified network code
  deposit: boolean;
  withdraw: boolean;
  withdrawFee: number; // in asset units (NaN = unknown)
  withdrawMin: number;
  contractOk: boolean | null; // null = exchange doesn't expose the contract
}

export interface Fill {
  id: string;
  filled: number; // base qty
  cost: number; // quote qty (gross)
  feeBase: number;
  feeQuote: number;
}

/**
 * Exchanges keep deposits/withdrawals in a separate wallet from spot trading.
 * [fundAccount, tradeAccount] in ccxt `transfer()` terms; null = same account.
 */
const ACCOUNTS: Record<string, [string, string] | null> = {
  binance: null,
  gate: null,
  bitget: null,
  mexc: null,
  okx: ['funding', 'spot'],
  bybit: ['funding', 'unified'],
  kucoin: ['main', 'spot'],
};

/** Unified wrapper over one ccxt exchange: books, orders, deposits, withdrawals, internal transfers. */
export class Venue {
  readonly ex: any;
  readonly books = new Map<string, Book>();
  readonly net = new Map<string, NetInfo>(); // key: `${code}:${chain}`
  private stopped = false;

  constructor(readonly id: string, private quote: string) {
    const Cls = (ccxt as any).pro[id];
    if (!Cls) throw new Error(`exchange ${id} not supported by ccxt.pro`);
    const c = exchangeCreds(id);
    this.ex = new Cls({ ...c, enableRateLimit: true, options: { defaultType: 'spot', adjustForTimeDifference: true } });
  }

  get hasKeys() {
    return !!this.ex.apiKey;
  }
  symbol(asset: string) {
    return `${asset}/${this.quote}`;
  }
  hasMarket(asset: string) {
    const m = this.ex.markets?.[this.symbol(asset)];
    return !!m && m.active !== false && m.spot;
  }
  takerFee(asset: string): number {
    return this.ex.markets?.[this.symbol(asset)]?.taker ?? 0.001;
  }

  async init() {
    await this.ex.loadMarkets();
  }

  private worker?: Worker;

  /**
   * Stream all order books of this exchange in a dedicated worker thread
   * (auto-restarts on crash). Falls back to in-process streams if workers are off.
   */
  streamBooks(assets: string[], useWorker: boolean, throttleMs = 50) {
    if (!assets.length) return;
    if (!useWorker) return assets.forEach((a) => this.watchBook(a));
    const dev = import.meta.url.endsWith('.ts');
    const file = new URL(dev ? './bookWorker.ts' : './bookWorker.js', import.meta.url);
    let restarts = 0;
    const spawn = () => {
      const w = new Worker(file, {
        workerData: { exchangeId: this.id, symbols: assets.map((a) => ({ asset: a, symbol: this.symbol(a) })), depth: 20, throttleMs },
      });
      this.worker = w;
      w.on('message', (m: any) => {
        if (m.type === 'books') {
          for (const b of m.batch) this.books.set(b.asset, { bids: b.bids, asks: b.asks, ts: b.ts });
        } else if (m.type === 'error') {
          this.books.delete(m.asset);
          log.warn('book stream error', { ex: this.id, asset: m.asset, err: m.err });
        } else if (m.type === 'ready') {
          restarts = 0;
          log.info('market-data worker ready', { ex: this.id, symbols: m.count });
        } else if (m.type === 'fatal') {
          log.error('market-data worker fatal', { ex: this.id, err: m.err });
        }
      });
      w.on('error', (e) => log.error('market-data worker crashed', { ex: this.id, err: errMsg(e) }));
      w.on('exit', () => {
        for (const a of assets) this.books.delete(a); // never trade on data from a dead stream
        if (this.stopped) return;
        const delay = Math.min(1000 * 2 ** restarts++, 30_000);
        log.warn('market-data worker exited, restarting', { ex: this.id, inMs: delay });
        setTimeout(spawn, delay);
      });
    };
    spawn();
  }

  /** In-process WS order-book stream with reconnect (used when workers are disabled). */
  watchBook(asset: string) {
    const sym = this.symbol(asset);
    const loop = async () => {
      let backoff = 1000;
      while (!this.stopped) {
        try {
          const ob = await this.ex.watchOrderBook(sym, 20);
          this.books.set(asset, { bids: ob.bids.slice(0, 20), asks: ob.asks.slice(0, 20), ts: Date.now() });
          backoff = 1000;
        } catch (e) {
          this.books.delete(asset);
          if (this.stopped) return;
          log.warn('book stream error', { ex: this.id, sym, err: errMsg(e) });
          await sleep(backoff);
          backoff = Math.min(backoff * 2, 30_000);
        }
      }
    };
    void loop();
  }

  /**
   * Refresh deposit/withdraw status + fees per network. Price gaps usually
   * appear exactly when an exchange suspends a network — so this is checked often.
   */
  async refreshNetworks(assets: AssetCfg[], chains: Record<string, ChainCfg>) {
    let currencies: any = this.ex.currencies;
    if (this.hasKeys) {
      try {
        currencies = await this.ex.fetchCurrencies();
      } catch (e) {
        log.warn('fetchCurrencies failed', { ex: this.id, err: errMsg(e) });
      }
    }
    for (const a of assets) {
      const ch = chains[a.chain];
      for (const [code, addr] of [[a.symbol, a.address], [ch.stable.symbol, ch.stable.address]] as const) {
        const nets = currencies?.[code]?.networks ?? {};
        const key = Object.keys(nets).find((k) => ch.networkCodes.includes(k.toUpperCase()));
        const mapKey = `${code}:${a.chain}`;
        if (!key) {
          this.net.delete(mapKey);
          continue;
        }
        const n = nets[key];
        this.net.set(mapKey, {
          network: key,
          deposit: n.deposit !== false && n.active !== false,
          withdraw: n.withdraw !== false && n.active !== false,
          withdrawFee: n.fee === undefined || n.fee === null ? NaN : Number(n.fee),
          withdrawMin: Number(n.limits?.withdraw?.min ?? 0),
          contractOk: contractMatches(n.info, addr),
        });
      }
    }
  }

  /** Free balance in the account where the asset is needed. */
  async free(code: string, where: 'fund' | 'trade'): Promise<number> {
    const acc = ACCOUNTS[this.id];
    const params = acc ? { type: where === 'fund' ? acc[0] : acc[1] } : {};
    const b = await this.ex.fetchBalance(params);
    return Number(b?.free?.[code] ?? 0);
  }

  /** Move funds between funding and trading account where the exchange separates them. */
  async move(code: string, amount: number, to: 'fund' | 'trade') {
    const acc = ACCOUNTS[this.id];
    if (!acc || amount <= 0) return;
    const [from, dst] = to === 'trade' ? [acc[0], acc[1]] : [acc[1], acc[0]];
    await this.ex.transfer(code, Number(this.ex.currencyToPrecision(code, amount)), from, dst);
  }

  async marketBuyWithQuote(asset: string, quoteAmount: number, refAsk: number): Promise<Fill> {
    const sym = this.symbol(asset);
    let o: any;
    if (this.ex.has['createMarketBuyOrderWithCost']) {
      o = await this.ex.createMarketBuyOrderWithCost(sym, quoteAmount);
    } else {
      const amt = Number(this.ex.amountToPrecision(sym, quoteAmount / refAsk));
      o = await this.ex.createOrder(sym, 'market', 'buy', amt, refAsk);
    }
    return this.settle(o, sym, asset);
  }

  async marketSell(asset: string, amount: number): Promise<Fill> {
    const sym = this.symbol(asset);
    const amt = Number(this.ex.amountToPrecision(sym, amount));
    const o = await this.ex.createOrder(sym, 'market', 'sell', amt);
    return this.settle(o, sym, asset);
  }

  /** Wait for final fill data (many venues return an empty ack on create). */
  private async settle(o: any, sym: string, asset: string): Promise<Fill> {
    let order = o;
    for (let i = 0; i < 15 && (!order.filled || order.status === 'open' || !order.cost); i++) {
      await sleep(300);
      try {
        order = await this.ex.fetchOrder(o.id, sym);
      } catch {
        /* some venues lag */
      }
    }
    let feeBase = 0;
    let feeQuote = 0;
    const fees: any[] = order.fees?.length ? order.fees : order.fee ? [order.fee] : [];
    for (const f of fees) {
      if (f.currency === asset) feeBase += Number(f.cost ?? 0);
      else if (f.currency === this.quote) feeQuote += Number(f.cost ?? 0);
    }
    return { id: String(order.id), filled: Number(order.filled ?? 0), cost: Number(order.cost ?? 0), feeBase, feeQuote };
  }

  // ─────────── Perpetual hedge (USDT-margined linear swaps) ───────────
  perpSymbol(asset: string) {
    return `${asset}/${this.quote}:${this.quote}`;
  }
  hasPerp(asset: string) {
    const m = this.ex.markets?.[this.perpSymbol(asset)];
    return !!m && m.active !== false && m.swap && m.linear;
  }
  perpTakerFee(asset: string): number {
    return this.ex.markets?.[this.perpSymbol(asset)]?.taker ?? 0.0006;
  }
  private leverageSet = new Set<string>();

  /** Free USDT usable as perp margin (USDⓈ-M futures / unified / swap account). */
  async marginFree(): Promise<number> {
    const b = await this.ex.fetchBalance({ type: 'swap' });
    return Number(b?.free?.[this.quote] ?? 0);
  }

  /**
   * Open (side='sell') or close (side='buy', reduceOnly) a short of `qty` base units.
   * Converts base qty → contracts via contractSize (OKX/Gate contracts ≠ coins).
   * Returns base filled and average price.
   */
  async perpOrder(asset: string, side: 'sell' | 'buy', qty: number, leverage: number, reduceOnly: boolean) {
    const sym = this.perpSymbol(asset);
    const m = this.ex.markets[sym];
    if (!this.leverageSet.has(sym)) {
      try {
        await this.ex.setLeverage(leverage, sym);
      } catch (e) {
        log.debug('setLeverage failed (may already be set)', { ex: this.id, sym, err: errMsg(e) });
      }
      this.leverageSet.add(sym);
    }
    const cs = Number(m.contractSize ?? 1);
    const contracts = Number(this.ex.amountToPrecision(sym, qty / cs));
    if (contracts <= 0) throw new Error(`hedge size below 1 contract (${qty} ${asset})`);
    let o = await this.ex.createOrder(sym, 'market', side, contracts, undefined, reduceOnly ? { reduceOnly: true } : {});
    for (let i = 0; i < 10 && (!o.filled || !o.average); i++) {
      await sleep(300);
      try {
        o = await this.ex.fetchOrder(o.id, sym);
      } catch {
        /* lag */
      }
    }
    const filledBase = Number(o.filled ?? contracts) * cs;
    const avg = Number(o.average ?? o.price ?? 0);
    return { id: String(o.id), filledBase, avg, fee: filledBase * avg * this.perpTakerFee(asset) };
  }

  async depositAddress(code: string, network: string): Promise<Address> {
    const r = await this.ex.fetchDepositAddress(code, { network });
    if (r.tag) throw new Error(`deposit ${code} on ${this.id} requires memo/tag — not supported`);
    return r.address as Address;
  }

  async withdraw(code: string, amount: number, address: Address, network: string): Promise<string> {
    const amt = Number(this.ex.currencyToPrecision(code, amount));
    const r = await this.ex.withdraw(code, amt, address, undefined, { network });
    return String(r.id);
  }

  /** Find a recent withdrawal to `address` (crash recovery: never withdraw twice). */
  async findWithdrawal(code: string, address: string, since: number): Promise<string | null> {
    const ws = await this.ex.fetchWithdrawals(code, since);
    const w = ws.find((x: any) => String(x.address ?? '').toLowerCase() === address.toLowerCase());
    return w ? String(w.id) : null;
  }

  async withdrawalStatus(code: string, id: string, since: number): Promise<{ status: string; txid?: string } | null> {
    const ws = await this.ex.fetchWithdrawals(code, since);
    const w = ws.find((x: any) => String(x.id) === id);
    return w ? { status: w.status, txid: w.txid } : null;
  }

  async close() {
    this.stopped = true;
    if (this.worker) {
      this.worker.postMessage('stop');
      setTimeout(() => void this.worker?.terminate(), 2000).unref();
    }
    try {
      await this.ex.close();
    } catch {
      /* ignore */
    }
  }
}

/** If the exchange exposes contract addresses, verify it's OUR token (same ticker ≠ same token!). */
function contractMatches(info: unknown, addr: string): boolean | null {
  const found = JSON.stringify(info ?? {}).toLowerCase().match(/0x[0-9a-f]{40}/g);
  if (!found) return null;
  return found.includes(addr.toLowerCase());
}
