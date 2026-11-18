import type { Config, AssetCfg } from '../config.js';
import type { Venue } from '../cex/venue.js';
import type { ChainWallet } from '../chain/wallet.js';
import type { Kyber } from '../chain/kyber.js';
import type { CycleRunner } from './cycles.js';
import type { RiskManager } from './risk.js';
import { Curve, evalCexToDex, evalDexToCex, pickBest, type Opportunity, type Costs } from './strategy.js';
import { log, errMsg } from './logger.js';
import { toUnits, fromUnits } from './utils.js';

interface Candidate extends Opportunity {
  exchange: string;
  asset: AssetCfg;
  key: string;
}

/** Scans every (exchange × asset) pair in both directions and launches cycles. */
export class Scanner {
  private streak = new Map<string, number>();
  private lastLogged = new Map<string, number>();
  private scans = 0;

  constructor(
    private cfg: Config,
    private venues: Map<string, Venue>,
    private wallets: Map<string, ChainWallet>,
    private kyber: Kyber,
    private runner: CycleRunner,
    private risk: RiskManager,
  ) {}

  async scan() {
    const cands: Candidate[] = [];
    const seen = new Set<string>();
    await Promise.all(
      this.cfg.assets.map(async (a) => {
        try {
          for (const c of await this.scanAsset(a)) {
            cands.push(c);
            seen.add(c.key);
          }
        } catch (e) {
          log.warn('scan asset failed', { asset: a.symbol, err: errMsg(e) });
        }
      }),
    );
    // opportunity must persist N consecutive scans (filters stale quotes / one-tick spikes)
    for (const k of [...this.streak.keys()]) if (!seen.has(k)) this.streak.delete(k);
    for (const c of cands) this.streak.set(c.key, (this.streak.get(c.key) ?? 0) + 1);

    const ready = cands.filter((c) => (this.streak.get(c.key) ?? 0) >= this.cfg.strategy.confirmScans).sort((a, b) => b.profitUsd - a.profitUsd);
    for (const c of ready) await this.maybeStart(c);

    if (++this.scans % 50 === 0) log.info('heartbeat', { scans: this.scans, candidates: cands.length, dailyPnl: this.risk.dailyPnl });
  }

  private async scanAsset(a: AssetCfg): Promise<Candidate[]> {
    const chain = this.cfg.chains[a.chain];
    const s = this.cfg.strategy;
    const now = Date.now();
    const live = [...this.venues.values()].filter((v) => {
      const b = v.books.get(a.symbol);
      return b && now - b.ts < this.cfg.risk.orderBookStaleMs && b.bids.length && b.asks.length;
    });
    if (!live.length) return [];
    const mids = live.map((v) => {
      const b = v.books.get(a.symbol)!;
      return (b.bids[0][0] + b.asks[0][0]) / 2;
    }).sort((x, y) => x - y);
    const mid = mids[Math.floor(mids.length / 2)];

    // DEX curves: one set of aggregator quotes per asset, shared by all exchanges
    const sizes = s.tradeSizesQuote;
    const [sellQ, buyQ] = await Promise.all([
      Promise.all(sizes.map((q) => this.kyber.quote(chain.kyberSlug, a.address, chain.stable.address, toUnits(q / mid, a.decimals)).catch(() => null))),
      Promise.all(sizes.map((q) => this.kyber.quote(chain.kyberSlug, chain.stable.address, a.address, toUnits(q, chain.stable.decimals)).catch(() => null))),
    ]);
    const sell = new Curve(sellQ.flatMap((q) => (q ? [{ in: fromUnits(q.amountIn, a.decimals), out: fromUnits(q.amountOut, chain.stable.decimals) }] : [])));
    const buy = new Curve(buyQ.flatMap((q) => (q ? [{ in: fromUnits(q.amountIn, chain.stable.decimals), out: fromUnits(q.amountOut, a.decimals) }] : [])));
    const gasList = [...sellQ, ...buyQ].flatMap((q) => (q ? [q.gasUsd] : []));
    const dexGasUsd = gasList.length ? Math.max(...gasList) : 1;
    if (sell.empty && buy.empty) return [];

    const out: Candidate[] = [];
    for (const v of live) {
      if (!v.hasMarket(a.symbol)) continue;
      const book = v.books.get(a.symbol)!;
      const an = v.net.get(`${a.symbol}:${a.chain}`);
      const sn = v.net.get(`${chain.stable.symbol}:${a.chain}`);
      const netKnown = !!an;
      if (an?.contractOk === false) continue; // same ticker, different token — never trade
      if (!netKnown && !this.cfg.dryRun) continue;

      const wFee = an && Number.isFinite(an.withdrawFee) ? an.withdrawFee : NaN;
      const costs: Costs = {
        takerFee: v.takerFee(a.symbol),
        withdrawFeeAsset: Number.isFinite(wFee) ? wFee : 0,
        withdrawFeeStable: sn && Number.isFinite(sn.withdrawFee) ? sn.withdrawFee : 1,
        dexGasUsd,
        transferGasUsd: chain.transferGasUsd,
        riskBufferBps: s.riskBufferBps,
        autoReturn: s.autoReturn,
      };
      const canC2D = !an || (an.withdraw && Number.isFinite(wFee));
      const canD2C = !an || an.deposit;
      const ops: (Opportunity | null)[] = [];
      for (const q of sizes) {
        if (canC2D && !sell.empty) ops.push(evalCexToDex(q, book.asks, sell, costs));
        if (canD2C && !buy.empty) ops.push(evalDexToCex(q, book.bids, buy, costs));
      }
      const best = pickBest(ops, s.minProfitUsd, s.minProfitBps);
      if (best) out.push({ ...best, exchange: v.id, asset: a, key: `${v.id}:${a.symbol}:${best.direction}` + (netKnown ? '' : ':netUnknown') });
    }
    return out;
  }

  private async maybeStart(c: Candidate) {
    const logKey = c.key;
    const shouldLog = Date.now() - (this.lastLogged.get(logKey) ?? 0) > 60_000;
    if (shouldLog) {
      this.lastLogged.set(logKey, Date.now());
      log.info('OPPORTUNITY', { ex: c.exchange, asset: c.asset.symbol, dir: c.direction, size: c.sizeQuote, profitUsd: +c.profitUsd.toFixed(2), bps: +c.profitBps.toFixed(1), costsUsd: +c.costsUsd.toFixed(2), netUnknown: c.key.endsWith('netUnknown') || undefined });
    }
    if (this.cfg.dryRun || !this.risk.canTrade()) return;
    if (this.runner.lockedAssets().has(c.asset.symbol)) return;
    if (this.runner.lockedAssets().size >= this.cfg.risk.maxConcurrentCycles) return;

    const venue = this.venues.get(c.exchange)!;
    const chain = this.cfg.chains[c.asset.chain];
    const wallet = this.wallets.get(c.asset.chain)!;
    try {
      if (c.direction === 'CEX_TO_DEX') {
        if ((await venue.free(this.cfg.quote, 'trade')) < c.sizeQuote) return void log.debug('not enough quote on cex', { ex: c.exchange });
      } else {
        const stable = fromUnits(await wallet.balanceOf(chain.stable.address), chain.stable.decimals);
        if (stable < c.sizeQuote) return void log.debug('not enough stable in wallet', { chain: chain.name });
      }
      // gas for swaps/transfers must always be there
      if (fromUnits(await wallet.nativeBalance(), 18) < chain.minNativeBalance) {
        log.warn('native gas balance too low', { chain: chain.name });
        return;
      }
    } catch (e) {
      log.warn('capital check failed', { err: errMsg(e) });
      return;
    }

    const id = `${Date.now().toString(36)}-${c.exchange}-${c.asset.symbol}`;
    log.info('START CYCLE', { id, dir: c.direction, size: c.sizeQuote, expectedUsd: +c.profitUsd.toFixed(2) });
    this.runner.start({
      id,
      direction: c.direction,
      exchange: c.exchange,
      asset: c.asset.symbol,
      chain: c.asset.chain,
      sizeQuote: c.sizeQuote,
      expectedProfitUsd: c.profitUsd,
      expectedOut: c.expectedOut,
      step: c.direction === 'CEX_TO_DEX' ? 'CEX_BUY' : 'DEX_BUY',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      stepStartedAt: Date.now(),
    });
  }
}
