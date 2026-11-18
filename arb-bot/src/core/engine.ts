import type { Config } from '../config.js';
import { BinanceRest, BinanceApiError, type OrderBook, type SymbolFilters, type FillResult } from '../cex/binance.js';
import { UniswapV3 } from '../dex/uniswapV3.js';
import { RiskManager } from './risk.js';
import { Notifier } from './notifier.js';
import { log, errMsg } from './logger.js';
import { evalDexBuy, evalDexSell, pickBest, sizeLadder, type Evaluation, type CostParams } from './strategy.js';
import { floorToStep, fromUnits, toUnits, sleep } from './utils.js';

interface Inventory {
  cexBase: number;
  cexQuote: number;
  dexBase: number;
  dexQuote: number;
  updatedAt: number;
}

export class Engine {
  private busy = false;
  private pending = false;
  private lastEvalMid = 0;
  private lastTradeAt = 0;
  private gasPriceWei = 0n;
  private inv: Inventory = { cexBase: 0, cexQuote: 0, dexBase: 0, dexQuote: 0, updatedAt: 0 };
  private evals = 0;

  constructor(
    private cfg: Config,
    private rest: BinanceRest,
    private dex: UniswapV3,
    private risk: RiskManager,
    private notify: Notifier,
    private filters: SymbolFilters,
    private getBook: () => OrderBook | null,
  ) {}

  get isBusy() {
    return this.busy;
  }

  async refreshInventory() {
    const c = this.cfg.chain;
    const [cex, dexBase, dexQuote] = await Promise.all([
      this.rest.getBalances([this.cfg.baseAsset, this.cfg.quoteAsset]).catch((e) => {
        if (!this.cfg.dryRun) throw e;
        return { [this.cfg.baseAsset]: Infinity, [this.cfg.quoteAsset]: Infinity };
      }),
      this.dex.address ? this.dex.balanceOf(c.baseToken) : Promise.resolve(-1n),
      this.dex.address ? this.dex.balanceOf(c.quoteToken) : Promise.resolve(-1n),
    ]);
    this.inv = {
      cexBase: cex[this.cfg.baseAsset] ?? 0,
      cexQuote: cex[this.cfg.quoteAsset] ?? 0,
      dexBase: dexBase < 0n ? Infinity : fromUnits(dexBase, c.baseDecimals),
      dexQuote: dexQuote < 0n ? Infinity : fromUnits(dexQuote, c.quoteDecimals),
      updatedAt: Date.now(),
    };
    log.info('inventory', { ...this.inv });
  }

  async onNewBlock(bn: bigint) {
    try {
      this.gasPriceWei = await this.dex.gasPrice();
    } catch (e) {
      log.warn('gas price fetch failed', { err: errMsg(e) });
    }
    log.debug('block', { bn });
    this.trigger();
  }

  onBook(b: OrderBook) {
    const mid = midOf(b);
    if (!mid || !this.lastEvalMid) return;
    const moveBps = (Math.abs(mid - this.lastEvalMid) / this.lastEvalMid) * 1e4;
    if (moveBps >= this.cfg.strategy.reevalOnCexMoveBps) this.trigger();
  }

  /** Single-flight: at most one evaluation/execution at a time, coalescing triggers. */
  trigger() {
    if (this.busy) {
      this.pending = true;
      return;
    }
    this.busy = true;
    this.cycle()
      .catch((e) => log.error('cycle error', { err: errMsg(e) }))
      .finally(() => {
        this.busy = false;
        if (this.pending) {
          this.pending = false;
          setImmediate(() => this.trigger());
        }
      });
  }

  private bookFresh(b: OrderBook | null): b is OrderBook {
    return !!b && Date.now() - b.receivedAt < this.cfg.strategy.cexStaleMs && b.bids.length > 0 && b.asks.length > 0;
  }

  private async cycle() {
    if (!this.risk.canTrade()) return;
    if (Date.now() - this.lastTradeAt < this.cfg.risk.tradeCooldownMs) return;
    const book0 = this.getBook();
    if (!this.bookFresh(book0)) return;
    const mid = midOf(book0)!;
    this.lastEvalMid = mid;

    const s = this.cfg.strategy;
    const c = this.cfg.chain;
    const sizes = sizeLadder(s.minTradeQuote, s.maxTradeQuote, s.sizeSteps);
    const t0 = Date.now();

    // All DEX quotes for both directions in parallel (batched into one RPC round-trip).
    const buyQuotes = sizes.map((q) =>
      this.dex.quoteExactIn(c.quoteToken, c.baseToken, toUnits(q, c.quoteDecimals)).catch(() => null),
    );
    const sellBaseIns = sizes.map((q) => floorToStep(q / mid, this.filters.stepSize));
    const sellQuotes = sellBaseIns.map((b) =>
      b > 0 ? this.dex.quoteExactIn(c.baseToken, c.quoteToken, toUnits(b, c.baseDecimals)).catch(() => null) : Promise.resolve(null),
    );
    const [buyOut, sellOut] = await Promise.all([Promise.all(buyQuotes), Promise.all(sellQuotes)]);
    const quoteMs = Date.now() - t0;

    // Use the freshest book after the RPC round-trip.
    const book = this.getBook();
    if (!this.bookFresh(book)) return;
    const params: CostParams = {
      takerFee: this.cfg.binance.takerFee,
      stepSize: this.filters.stepSize,
      minQty: this.filters.minQty,
      minNotional: this.filters.minNotional,
      gasUsd: fromUnits(this.gasPriceWei * BigInt(c.swapGasUnits), 18) * midOf(book)!,
    };

    const r = this.cfg.risk;
    const evals: (Evaluation | null)[] = [];
    sizes.forEach((q, i) => {
      const bo = buyOut[i];
      // DEX buy needs quote on-chain, CEX sell needs base on Binance
      if (bo !== null && this.inv.dexQuote - q >= r.minQuoteReserve) {
        const e = evalDexBuy(q, fromUnits(bo, c.baseDecimals), book.bids, params);
        if (e && this.inv.cexBase - e.cexBaseQty >= r.minBaseReserve) evals.push(e);
      }
      const so = sellOut[i];
      const bIn = sellBaseIns[i];
      if (so !== null && this.inv.dexBase - bIn >= r.minBaseReserve) {
        const e = evalDexSell(bIn, fromUnits(so, c.quoteDecimals), book.asks, params);
        if (e && this.inv.cexQuote - e.cexQuote >= r.minQuoteReserve) evals.push(e);
      }
    });

    if (++this.evals % 200 === 0) {
      const top = evals.filter(Boolean).sort((a, b) => b!.profitUsd - a!.profitUsd)[0];
      log.info('heartbeat', { evals: this.evals, mid, quoteMs, bestEdgeUsd: top?.profitUsd.toFixed(3), bestBps: top?.profitBps.toFixed(2), pnl: this.risk.dailyPnl });
    }

    const best = pickBest(evals, s.minProfitUsd, s.minProfitBps);
    if (!best) return;

    log.info('OPPORTUNITY', { ...best, quoteMs, bookAgeMs: Date.now() - book.receivedAt });
    if (this.cfg.dryRun) {
      this.lastTradeAt = Date.now();
      return;
    }
    await this.execute(best, book);
  }

  /**
   * DEX leg first (atomic, guarded by minOut), then hedge the exact filled
   * amount on the CEX. DEX failure = no position; CEX hedge is retried.
   */
  private async execute(e: Evaluation, book: OrderBook) {
    const c = this.cfg.chain;
    const slip = BigInt(10_000 - this.cfg.strategy.dexSlippageBps);
    const ethUsd = midOf(book)!;
    this.lastTradeAt = Date.now();

    const isBuy = e.direction === 'DEX_BUY_CEX_SELL';
    const tokenIn = isBuy ? c.quoteToken : c.baseToken;
    const tokenOut = isBuy ? c.baseToken : c.quoteToken;
    const amountIn = toUnits(e.dexIn, isBuy ? c.quoteDecimals : c.baseDecimals);
    const expectedOut = toUnits(e.dexOut, isBuy ? c.baseDecimals : c.quoteDecimals);
    const minOut = (expectedOut * slip) / 10_000n;

    let swap;
    try {
      swap = await this.dex.swapExactIn(tokenIn, tokenOut, amountIn, minOut, this.cfg.strategy.txDeadlineSec);
    } catch (err) {
      const gasWei = (err as { gasCostWei?: bigint }).gasCostWei ?? 0n;
      const lossUsd = fromUnits(gasWei, 18) * ethUsd;
      log.warn('DEX leg failed, no position opened', { err: errMsg(err), lossUsd });
      this.risk.recordFailure(lossUsd);
      await this.refreshInventory().catch(() => {});
      return;
    }
    const gasUsd = fromUnits(swap.gasCostWei, 18) * ethUsd;
    log.info('DEX leg filled', { tx: swap.txHash, latencyMs: swap.latencyMs, out: swap.amountOut });

    // Hedge on CEX
    const hedgeQty = isBuy ? floorToStep(fromUnits(swap.amountOut, c.baseDecimals), this.filters.stepSize) : e.cexBaseQty;
    let fill: FillResult;
    try {
      fill = await this.hedge(isBuy ? 'SELL' : 'BUY', hedgeQty);
    } catch (err) {
      const msg = `CEX HEDGE FAILED — UNHEDGED ${isBuy ? 'LONG' : 'SHORT'} ${hedgeQty} ${this.cfg.baseAsset}. Manual action required. ${errMsg(err)}`;
      this.risk.halt(msg);
      this.notify.send(`🚨 ${msg}`);
      return;
    }

    const pnl = isBuy
      ? fill.quoteAmount - fill.commissionQuote - e.dexIn - gasUsd
      : fromUnits(swap.amountOut, c.quoteDecimals) - fill.quoteAmount - fill.commissionQuote - gasUsd;
    this.risk.recordTrade(pnl);
    const summary = {
      direction: e.direction,
      expectedUsd: +e.profitUsd.toFixed(3),
      realizedUsd: +pnl.toFixed(3),
      gasUsd: +gasUsd.toFixed(3),
      cexAvg: fill.avgPrice,
      tx: swap.txHash,
      dailyPnl: +this.risk.dailyPnl.toFixed(2),
      totalMs: Date.now() - this.lastTradeAt,
    };
    log.info('TRADE DONE', summary);
    this.notify.send(`✅ ${e.direction} pnl ${summary.realizedUsd}$ (exp ${summary.expectedUsd}$), day ${summary.dailyPnl}$`);
    await this.refreshInventory().catch((er) => log.warn('inventory refresh failed', { err: errMsg(er) }));
  }

  private async hedge(side: 'BUY' | 'SELL', qty: number): Promise<FillResult> {
    let lastErr: unknown;
    for (let i = 0; i < 4; i++) {
      try {
        const f = await this.rest.marketOrder(this.cfg.cexSymbol, side, String(qty), this.cfg.quoteAsset);
        if (f.executedBase + this.filters.stepSize / 2 < qty) {
          throw new Error(`partial hedge ${f.executedBase}/${qty} status=${f.status}`);
        }
        return f;
      } catch (err) {
        lastErr = err;
        // Definitive rejections like insufficient balance / bad qty won't fix themselves
        if (err instanceof BinanceApiError && [-2010, -1013, -1111].includes(err.code)) break;
        if (/partial hedge/.test(errMsg(err))) break;
        log.warn('hedge attempt failed, retrying', { attempt: i + 1, err: errMsg(err) });
        await sleep(150 * (i + 1));
      }
    }
    throw lastErr;
  }
}

export function midOf(b: OrderBook | null): number | null {
  if (!b || !b.bids.length || !b.asks.length) return null;
  return (b.bids[0][0] + b.asks[0][0]) / 2;
}
