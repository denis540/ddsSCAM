import type { Config, AssetCfg } from '../config.js';
import type { Venue, Book } from '../cex/venue.js';
import type { ChainWallet } from '../chain/wallet.js';
import type { DexRouter, Quote } from '../chain/aggregators.js';
import type { CycleRunner } from './cycles.js';
import type { RiskManager } from './risk.js';
import type { Journal, Blacklist } from './journal.js';
import { Curve, evalCexToDex, evalDexToCex, pickBest, walkBids, type Opportunity, type Costs } from './strategy.js';
import { log, errMsg } from './logger.js';
import { toUnits, fromUnits } from './utils.js';
import { loopLag } from './lag.js';

interface Candidate extends Opportunity {
  exchange: string;
  asset: AssetCfg;
  key: string;
  hedgeVenue?: string;
  takerFee: number;
  bufferUsd: number;
  netUnknown: boolean;
}

/**
 * Scans every (exchange × asset) pair in both directions and launches cycles.
 *
 * Two-stage to scale to hundreds of tokens without hitting aggregator limits:
 *  1. probe: one quote per direction from the first aggregator at a mid size;
 *  2. full: size ladder from ALL aggregators — only for sides where the probe
 *     shows an edge ≥ probeEdgeBps against the best CEX price.
 */
export class Scanner {
  private streak = new Map<string, number>();
  private lastLogged = new Map<string, number>();
  private paperBusy = new Set<string>();
  private scans = 0;
  lastCandidates: Candidate[] = [];

  constructor(
    private cfg: Config,
    private venues: Map<string, Venue>,
    private wallets: Map<string, ChainWallet>,
    private dex: DexRouter,
    private runner: CycleRunner,
    private risk: RiskManager,
    private journal: Journal,
    private blacklist: Blacklist,
  ) {}

  async scan() {
    const cands: Candidate[] = [];
    const assets = this.cfg.assets.filter((a) => !this.blacklist.has(a.symbol, a.chain));
    const par = this.cfg.strategy.maxAssetsParallel;
    for (let i = 0; i < assets.length; i += par) {
      await Promise.all(
        assets.slice(i, i + par).map(async (a) => {
          try {
            cands.push(...(await this.scanAsset(a)));
          } catch (e) {
            log.debug('scan asset failed', { asset: a.symbol, err: errMsg(e) });
          }
        }),
      );
    }
    // must persist N consecutive scans (filters stale quotes / one-tick spikes)
    const seen = new Set(cands.map((c) => c.key));
    for (const k of [...this.streak.keys()]) if (!seen.has(k)) this.streak.delete(k);
    for (const c of cands) this.streak.set(c.key, (this.streak.get(c.key) ?? 0) + 1);
    this.lastCandidates = cands;

    const ready = cands.filter((c) => (this.streak.get(c.key) ?? 0) >= this.cfg.strategy.confirmScans).sort((a, b) => b.profitUsd - a.profitUsd);
    for (const c of ready) await this.maybeStart(c);

    if (++this.scans % 50 === 0) log.info('heartbeat', { scans: this.scans, assets: assets.length, candidates: cands.length, dailyPnl: +this.risk.dailyPnl.toFixed(2), ...loopLag(true) });
  }

  private freshBook(v: Venue, asset: string): Book | null {
    const b = v.books.get(asset);
    return b && Date.now() - b.ts < this.cfg.risk.orderBookStaleMs && b.bids.length && b.asks.length ? b : null;
  }

  hedgeVenueFor(exchange: string, asset: string): string | undefined {
    const h = this.cfg.strategy.hedge;
    if (!h.enabled) return undefined;
    const ok = (id: string) => {
      const v = this.venues.get(id);
      return !!v && v.hasPerp(asset) && (this.cfg.dryRun || v.hasKeys);
    };
    if (ok(exchange)) return exchange;
    return h.venues.find(ok);
  }

  private async scanAsset(a: AssetCfg): Promise<Candidate[]> {
    const chain = this.cfg.chains[a.chain];
    const s = this.cfg.strategy;
    const live = [...this.venues.values()].filter((v) => v.hasMarket(a.symbol) && this.freshBook(v, a.symbol));
    if (!live.length) return [];
    const books = new Map(live.map((v) => [v.id, this.freshBook(v, a.symbol)!]));
    const mids = [...books.values()].map((b) => (b.bids[0][0] + b.asks[0][0]) / 2).sort((x, y) => x - y);
    const mid = mids[Math.floor(mids.length / 2)];
    const bestAsk = Math.min(...[...books.values()].map((b) => b.asks[0][0]));
    const bestBid = Math.max(...[...books.values()].map((b) => b.bids[0][0]));

    // ── stage 1: probe
    const sizes = s.tradeSizesQuote;
    const probeSize = sizes[Math.floor(sizes.length / 2)];
    const sellIn = (q: number) => toUnits(q / mid, a.decimals);
    const [pSell, pBuy] = await Promise.all([
      this.dex.quote(chain, a.address, chain.stable.address, sellIn(probeSize), { fast: true }).catch(() => null),
      this.dex.quote(chain, chain.stable.address, a.address, toUnits(probeSize, chain.stable.decimals), { fast: true }).catch(() => null),
    ]);
    const edge = s.probeEdgeBps / 1e4;
    const dexSellPx = pSell ? fromUnits(pSell.amountOut, chain.stable.decimals) / fromUnits(pSell.amountIn, a.decimals) : 0;
    const dexBuyPx = pBuy ? probeSize / fromUnits(pBuy.amountOut, a.decimals) : Infinity;
    const doC2D = dexSellPx > bestAsk * (1 + edge);
    const doD2C = dexBuyPx < bestBid * (1 - edge);
    if (!doC2D && !doD2C) return [];

    // ── stage 2: full ladder, all aggregators
    const ladder = (fn: (q: number) => Promise<Quote>) => Promise.all(sizes.map((q) => fn(q).catch(() => null)));
    const [sellQ, buyQ] = await Promise.all([
      doC2D ? ladder((q) => this.dex.quote(chain, a.address, chain.stable.address, sellIn(q), { usdPerOutUnit: 10 ** -chain.stable.decimals })) : Promise.resolve([]),
      doD2C ? ladder((q) => this.dex.quote(chain, chain.stable.address, a.address, toUnits(q, chain.stable.decimals), { usdPerOutUnit: mid * 10 ** -a.decimals })) : Promise.resolve([]),
    ]);
    const sell = new Curve(sellQ.flatMap((q) => (q ? [{ in: fromUnits(q.amountIn, a.decimals), out: fromUnits(q.amountOut, chain.stable.decimals) }] : [])));
    const buy = new Curve(buyQ.flatMap((q) => (q ? [{ in: fromUnits(q.amountIn, chain.stable.decimals), out: fromUnits(q.amountOut, a.decimals) }] : [])));
    const gasList = [...sellQ, ...buyQ].flatMap((q) => (q ? [q.gasUsd] : []));
    const dexGasUsd = gasList.length ? Math.max(...gasList) : 1;

    const out: Candidate[] = [];
    for (const v of live) {
      const book = books.get(v.id)!;
      const an = v.net.get(`${a.symbol}:${a.chain}`);
      const sn = v.net.get(`${chain.stable.symbol}:${a.chain}`);
      if (an?.contractOk === false) continue; // same ticker, different token — never trade
      if (!an && !this.cfg.dryRun) continue;

      const hedgeVenue = this.hedgeVenueFor(v.id, a.symbol);
      if (s.hedge.enabled && s.hedge.required && !hedgeVenue) continue;
      const hedgeFeeBps = hedgeVenue ? 2 * this.venues.get(hedgeVenue)!.perpTakerFee(a.symbol) * 1e4 : 0;
      // hedged transfers carry only basis risk → smaller buffer
      const riskBufferBps = hedgeVenue ? s.riskBufferBps * 0.3 : s.riskBufferBps;

      const wFee = an && Number.isFinite(an.withdrawFee) ? an.withdrawFee : NaN;
      const takerFee = v.takerFee(a.symbol);
      const costs: Costs = {
        takerFee,
        withdrawFeeAsset: Number.isFinite(wFee) ? wFee : 0,
        withdrawFeeStable: sn && Number.isFinite(sn.withdrawFee) ? sn.withdrawFee : 1,
        dexGasUsd,
        transferGasUsd: chain.transferGasUsd,
        riskBufferBps,
        autoReturn: s.autoReturn,
        hedgeFeeBps,
      };
      const canC2D = !an || (an.withdraw && Number.isFinite(wFee));
      const canD2C = !an || an.deposit;
      const ops: (Opportunity | null)[] = [];
      for (const q of sizes) {
        if (doC2D && canC2D && !sell.empty) ops.push(evalCexToDex(q, book.asks, sell, costs));
        if (doD2C && canD2C && !buy.empty) ops.push(evalDexToCex(q, book.bids, buy, costs));
      }
      const best = pickBest(ops, s.minProfitUsd, s.minProfitBps);
      if (best) {
        out.push({
          ...best, exchange: v.id, asset: a, hedgeVenue, takerFee, netUnknown: !an,
          bufferUsd: (best.sizeQuote * riskBufferBps) / 1e4,
          key: `${v.id}:${a.symbol}:${a.chain}:${best.direction}`,
        });
      }
    }
    return out;
  }

  private async maybeStart(c: Candidate) {
    if (Date.now() - (this.lastLogged.get(c.key) ?? 0) > 60_000) {
      this.lastLogged.set(c.key, Date.now());
      log.info('OPPORTUNITY', {
        ex: c.exchange, asset: c.asset.symbol, chain: c.asset.chain, dir: c.direction, size: c.sizeQuote, profitUsd: +c.profitUsd.toFixed(2),
        bps: +c.profitBps.toFixed(1), costsUsd: +c.costsUsd.toFixed(2), hedge: c.hedgeVenue ?? 'none', netUnknown: c.netUnknown || undefined,
      });
    }
    if (this.cfg.dryRun) return this.paper(c);
    if (!this.risk.canTrade()) return;
    const locked = this.runner.lockedAssets();
    if (locked.has(c.asset.symbol) || locked.size >= this.cfg.risk.maxConcurrentCycles) return;

    const venue = this.venues.get(c.exchange)!;
    const chain = this.cfg.chains[c.asset.chain];
    const wallet = this.wallets.get(c.asset.chain)!;
    try {
      if (c.direction === 'CEX_TO_DEX') {
        if ((await venue.free(this.cfg.quote, 'trade')) < c.sizeQuote) return void log.debug('not enough quote on cex', { ex: c.exchange });
      } else if (fromUnits(await wallet.balanceOf(chain.stable.address), chain.stable.decimals) < c.sizeQuote) {
        return void log.debug('not enough stable in wallet', { chain: chain.name });
      }
      if (fromUnits(await wallet.nativeBalance(), 18) < chain.minNativeBalance) return void log.warn('native gas balance too low', { chain: chain.name });
      if (c.hedgeVenue) {
        const need = (c.sizeQuote / this.cfg.strategy.hedge.leverage) * 1.3;
        const margin = await this.venues.get(c.hedgeVenue)!.marginFree().catch(() => 0);
        if (margin < need) {
          if (this.cfg.strategy.hedge.required) return void log.warn('not enough perp margin for hedge', { venue: c.hedgeVenue, margin, need });
          log.warn('not enough perp margin — cycle will run unhedged', { venue: c.hedgeVenue, margin, need });
          c.hedgeVenue = undefined;
        }
      }
    } catch (e) {
      return void log.warn('capital check failed', { err: errMsg(e) });
    }

    const id = `${Date.now().toString(36)}-${c.exchange}-${c.asset.symbol}`;
    log.info('START CYCLE', { id, dir: c.direction, size: c.sizeQuote, expectedUsd: +c.profitUsd.toFixed(2), hedge: c.hedgeVenue });
    this.runner.start({
      id, direction: c.direction, exchange: c.exchange, asset: c.asset.symbol, chain: c.asset.chain, sizeQuote: c.sizeQuote,
      expectedProfitUsd: c.profitUsd, expectedOut: c.expectedOut, hedgeVenue: c.hedgeVenue,
      step: c.direction === 'CEX_TO_DEX' ? 'CEX_BUY' : 'DEX_BUY',
      createdAt: Date.now(), updatedAt: Date.now(), stepStartedAt: Date.now(),
    });
  }

  /**
   * Paper trading: pretend the first leg executed now and price the second leg
   * after `paperTransferMin` with real market data. This shows what the strategy
   * would really have earned, including price drift while coins travel.
   */
  private paper(c: Candidate) {
    if (this.paperBusy.has(c.key)) return;
    this.paperBusy.add(c.key);
    const v = this.venues.get(c.exchange)!;
    const hv = c.hedgeVenue ? this.venues.get(c.hedgeVenue) : undefined;
    const refMid = (venue: Venue | undefined) => {
      const b = venue?.books.get(c.asset.symbol);
      return b ? (b.bids[0][0] + b.asks[0][0]) / 2 : NaN;
    };
    const hedgeStart = refMid(hv ?? v);
    const t0 = Date.now();
    setTimeout(async () => {
      try {
        const chain = this.cfg.chains[c.asset.chain];
        let out: number;
        if (c.direction === 'CEX_TO_DEX') {
          const q = await this.dex.quote(chain, c.asset.address, chain.stable.address, toUnits(c.expectedAssetMoved, c.asset.decimals));
          out = fromUnits(q.amountOut, chain.stable.decimals);
        } else {
          const b = v.books.get(c.asset.symbol);
          const gross = b ? walkBids(b.bids, c.expectedAssetMoved) : null;
          if (gross === null) throw new Error('no book for paper second leg');
          out = gross * (1 - c.takerFee);
        }
        const realized = out - c.sizeQuote - (c.costsUsd - c.bufferUsd);
        const hedgeEnd = refMid(hv ?? v);
        const hedgeUsd = hv && Number.isFinite(hedgeStart) && Number.isFinite(hedgeEnd) ? (hedgeStart - hedgeEnd) * c.expectedAssetMoved : 0;
        this.journal.add({
          mode: 'paper', id: `paper-${t0.toString(36)}`, exchange: c.exchange, asset: c.asset.symbol, chain: c.asset.chain, direction: c.direction,
          sizeUsd: c.sizeQuote, expectedUsd: c.profitUsd, realizedUsd: realized, hedgeUsd, minutes: (Date.now() - t0) / 60000, note: c.hedgeVenue ? `hedge@${c.hedgeVenue}` : '',
        });
        log.info('PAPER RESULT', { key: c.key, expected: +c.profitUsd.toFixed(2), realized: +realized.toFixed(2), hedge: +hedgeUsd.toFixed(2), total: +(realized + hedgeUsd).toFixed(2) });
      } catch (e) {
        log.warn('paper eval failed', { key: c.key, err: errMsg(e) });
      } finally {
        this.paperBusy.delete(c.key);
      }
    }, this.cfg.strategy.paperTransferMin * 60_000);
  }
}
