import ccxt from 'ccxt';
import type { Config } from '../config.js';
import type { Venue } from '../cex/venue.js';
import type { ChainWallet } from '../chain/wallet.js';
import type { DexRouter } from '../chain/aggregators.js';
import { CycleStore, type Cycle, type Step } from './store.js';
import type { RiskManager } from './risk.js';
import type { Notifier } from './notifier.js';
import type { Journal, Blacklist } from './journal.js';
import { log, errMsg } from './logger.js';
import { fromUnits, toUnits, sleep } from './utils.js';
import { walkBids } from './strategy.js';

class Retryable extends Error {}

/** Received < quoted by more than slippage + this → token has a transfer tax / is a honeypot. */
const TAX_TOLERANCE_BPS = 200;

/**
 * Executes transfer-arbitrage cycles as a persisted state machine:
 *
 *  CEX_TO_DEX: CEX_BUY → [HEDGE_OPEN] → TO_FUND → WITHDRAW → AWAIT_ARRIVAL → DEX_SELL → [HEDGE_CLOSE] → [RETURN_DEPOSIT] → DONE
 *  DEX_TO_CEX: DEX_BUY → [HEDGE_OPEN] → DEPOSIT → AWAIT_CREDIT → TO_TRADE → CEX_SELL → [HEDGE_CLOSE] → [RETURN_WITHDRAW] → DONE
 *
 * HEDGE: while coins travel (minutes), a perp short of the same size neutralises
 * price moves — the cycle earns the spread instead of gambling on direction.
 *
 * Every money-moving call is marked `inflight` before it is sent. If the process
 * dies in between, the action is NOT blindly repeated: it is recovered from
 * exchange/chain history or parked as NEEDS_ATTENTION with an alert.
 */
export class CycleRunner {
  private running = new Set<string>();

  constructor(
    private cfg: Config,
    private store: CycleStore,
    private venues: Map<string, Venue>,
    private wallets: Map<string, ChainWallet>,
    private dex: DexRouter,
    private risk: RiskManager,
    private notify: Notifier,
    private journal: Journal,
    private blacklist: Blacklist,
  ) {}

  /** Assets with an active cycle are locked (balance-diff detection must not overlap). */
  lockedAssets(): Set<string> {
    return new Set(this.store.active().map((c) => c.asset));
  }

  start(c: Cycle) {
    this.store.save(c);
    this.run(c);
  }

  resumeAll() {
    for (const c of this.store.active()) {
      log.info('resuming cycle', { id: c.id, step: c.step, inflight: c.inflight });
      this.run(c);
    }
    for (const c of this.store.attention()) this.notify.send(`⚠️ cycle ${c.id} needs attention: ${c.error}`);
  }

  private run(c: Cycle) {
    if (this.running.has(c.id)) return;
    this.running.add(c.id);
    void (async () => {
      try {
        while (!['DONE', 'FAILED', 'NEEDS_ATTENTION'].includes(c.step)) {
          try {
            await this.step(c);
          } catch (e) {
            if (e instanceof Retryable || e instanceof ccxt.NetworkError) {
              if (!(e instanceof Retryable)) log.warn('network error, retrying step', { id: c.id, step: c.step, err: errMsg(e) });
              if (!c.inflight) {
                await sleep(5000);
                continue;
              }
            }
            throw e;
          }
        }
      } catch (e) {
        this.park(c, errMsg(e));
      } finally {
        this.running.delete(c.id);
        if (c.step === 'DONE') this.finish(c);
      }
    })();
  }

  private go(c: Cycle, next: Step, patch: Partial<Cycle> = {}) {
    Object.assign(c, patch, { step: next, inflight: undefined, stepStartedAt: Date.now() });
    this.store.save(c);
    log.info('cycle step', { id: c.id, step: next, ex: c.exchange, asset: c.asset });
  }

  private mark(c: Cycle) {
    c.inflight = c.step;
    this.store.save(c);
  }

  private park(c: Cycle, error: string) {
    const clean = (c.step === 'CEX_BUY' || c.step === 'DEX_BUY') && !c.inflight;
    c.step = clean ? 'FAILED' : 'NEEDS_ATTENTION';
    c.error = error;
    this.store.save(c);
    this.risk.recordFailure(c.gasUsd ?? 0);
    log.error('cycle stopped', { id: c.id, step: c.step, error });
    const hedgeNote = c.hedgeQty ? ` OPEN HEDGE: short ${c.hedgeQty} ${c.asset} on ${c.hedgeVenue}!` : '';
    this.notify.send(`${clean ? '❌' : '🚨'} ${c.id} ${c.direction} ${c.asset}@${c.exchange}: ${error}${hedgeNote}`);
  }

  private finish(c: Cycle) {
    const total = (c.pnlUsd ?? 0) + (c.hedgePnlUsd ?? 0);
    this.risk.recordTrade(total);
    const minutes = (c.updatedAt - c.createdAt) / 60000;
    this.journal.add({
      mode: 'live', id: c.id, exchange: c.exchange, asset: c.asset, chain: c.chain, direction: c.direction, sizeUsd: c.sizeQuote,
      expectedUsd: c.expectedProfitUsd, realizedUsd: c.pnlUsd ?? 0, hedgeUsd: c.hedgePnlUsd, minutes, dexSource: c.dexSource,
    });
    log.info('CYCLE DONE', { id: c.id, pnl: total, spreadPnl: c.pnlUsd, hedgePnl: c.hedgePnlUsd, expected: c.expectedProfitUsd });
    this.notify.send(`✅ ${c.direction} ${c.asset}@${c.exchange} ${c.sizeQuote}$ → pnl ${total.toFixed(2)}$ (exp ${c.expectedProfitUsd.toFixed(2)}$${c.hedgeQty ? `, hedge ${c.hedgePnlUsd?.toFixed(2)}$` : ''}) ${minutes.toFixed(1)} min`);
  }

  private ctx(c: Cycle) {
    const asset = this.cfg.assets.find((a) => a.symbol === c.asset && a.chain === c.chain)!;
    const chain = this.cfg.chains[c.chain];
    const venue = this.venues.get(c.exchange)!;
    const wallet = this.wallets.get(c.chain)!;
    return { asset, chain, venue, wallet };
  }

  private timedOut(c: Cycle) {
    return Date.now() - c.stepStartedAt > this.cfg.risk.transferTimeoutMin * 60_000;
  }

  /** What comes after the second leg (and hedge close). */
  private afterSecondLeg(c: Cycle): Step {
    const { chain, venue } = this.ctx(c);
    const sn = venue.net.get(`${chain.stable.symbol}:${chain.name}`);
    if (!this.cfg.strategy.autoReturn || chain.stable.symbol !== this.cfg.quote || !sn) return 'DONE';
    if (c.direction === 'CEX_TO_DEX') return sn.deposit ? 'RETURN_DEPOSIT' : 'DONE';
    return sn.withdraw ? 'RETURN_WITHDRAW' : 'DONE';
  }

  private afterFirstLeg(c: Cycle): Step {
    if (this.cfg.strategy.hedge.enabled && c.hedgeVenue) return 'HEDGE_OPEN';
    return c.direction === 'CEX_TO_DEX' ? 'TO_FUND' : 'DEPOSIT';
  }

  private checkTax(c: Cycle, received: bigint, quoted: bigint) {
    const minOk = (quoted * BigInt(10_000 - this.cfg.strategy.dexSlippageBps - TAX_TOLERANCE_BPS)) / 10_000n;
    if (received < minOk) {
      this.blacklist.add(c.asset, c.chain);
      const msg = `token ${c.asset}@${c.chain} received ${received} vs quoted ${quoted}: transfer tax / honeypot → blacklisted`;
      log.error(msg);
      this.notify.send(`🧨 ${msg}`);
    }
  }

  private async step(c: Cycle): Promise<void> {
    const { asset, chain, venue, wallet } = this.ctx(c);
    const assetNet = venue.net.get(`${asset.symbol}:${chain.name}`);
    const stableNet = venue.net.get(`${chain.stable.symbol}:${chain.name}`);
    const s = this.cfg.strategy;

    switch (c.step) {
      // ───────────── first legs ─────────────
      case 'CEX_BUY': {
        if (c.inflight) throw new Error('crashed during CEX buy — check order history manually');
        const book = venue.books.get(asset.symbol);
        if (!book) throw new Error('no order book');
        this.mark(c);
        const f = await venue.marketBuyWithQuote(asset.symbol, c.sizeQuote, book.asks[0][0]).catch((e) => this.rejectIfDefinitive(c, e));
        if (f.filled <= 0) throw new Error(`buy not filled (order ${f.id})`);
        return this.go(c, this.afterFirstLeg(c), { assetAmount: f.filled - f.feeBase, quoteSpent: f.cost + f.feeQuote });
      }
      case 'DEX_BUY': {
        if (c.inflight && !c.txHash) throw new Error('crashed while sending DEX buy — check wallet');
        let quoted = 0n;
        if (!c.txHash) {
          const r = await this.dex.swap(wallet, chain.stable.address, asset.address, toUnits(c.sizeQuote, chain.stable.decimals), s.dexSlippageBps, 0n, () => this.mark(c));
          c.txHash = r.hash;
          c.dexSource = r.source;
          quoted = r.quotedOut;
          this.store.save(c);
        }
        const got = await wallet.receivedInTx(c.txHash, asset.address);
        if (quoted) this.checkTax(c, got, quoted);
        return this.go(c, this.afterFirstLeg(c), { assetAmount: fromUnits(got, asset.decimals), quoteSpent: c.sizeQuote, txHash: undefined });
      }

      // ───────────── hedge ─────────────
      case 'HEDGE_OPEN': {
        if (c.inflight) throw new Error('crashed while opening hedge — check perp position');
        const hv = this.venues.get(c.hedgeVenue!)!;
        this.mark(c);
        let patch: Partial<Cycle> = {};
        try {
          const h = await hv.perpOrder(asset.symbol, 'sell', c.assetAmount!, s.hedge.leverage, false);
          patch = { hedgeQty: h.filledBase, hedgeOpenPx: h.avg, hedgePnlUsd: -h.fee };
          log.info('hedge opened', { id: c.id, venue: hv.id, qty: h.filledBase, px: h.avg });
        } catch (e) {
          if (e instanceof ccxt.NetworkError) throw e; // uncertain → attention via inflight
          log.warn('hedge open failed, continuing unhedged', { id: c.id, err: errMsg(e) });
          this.notify.send(`⚠️ ${c.id}: hedge failed (${errMsg(e)}), continuing unhedged`);
          patch = { hedgeVenue: undefined };
        }
        return this.go(c, c.direction === 'CEX_TO_DEX' ? 'TO_FUND' : 'DEPOSIT', patch);
      }
      case 'HEDGE_CLOSE': {
        if (c.inflight) throw new Error('crashed while closing hedge — check perp position');
        const hv = this.venues.get(c.hedgeVenue!)!;
        this.mark(c);
        try {
          const h = await hv.perpOrder(asset.symbol, 'buy', c.hedgeQty!, s.hedge.leverage, true);
          const pnl = (c.hedgeOpenPx! - h.avg) * h.filledBase - h.fee;
          log.info('hedge closed', { id: c.id, pnl });
          return this.go(c, this.afterSecondLeg(c), { hedgePnlUsd: (c.hedgePnlUsd ?? 0) + pnl, hedgeQty: undefined });
        } catch (e) {
          if (e instanceof ccxt.ExchangeError && !(e instanceof ccxt.NetworkError)) {
            c.inflight = undefined; // rejected → safe to retry
            this.store.save(c);
            if (!this.timedOut(c)) throw new Retryable();
          }
          throw e;
        }
      }

      // ───────────── transfers CEX → wallet ─────────────
      case 'TO_FUND': {
        await venue.move(asset.symbol, c.assetAmount!, 'fund');
        return this.go(c, 'WITHDRAW', { walletBalBefore: (await wallet.balanceOf(asset.address)).toString() });
      }
      case 'WITHDRAW': {
        if (!assetNet?.withdraw) {
          if (this.timedOut(c)) throw new Error('withdrawals stay suspended');
          throw new Retryable();
        }
        if (c.inflight) {
          const id = await venue.findWithdrawal(asset.symbol, wallet.address, c.stepStartedAt - 60_000);
          if (!id) throw new Error('crashed during withdraw request and no withdrawal found — verify manually');
          return this.go(c, 'AWAIT_ARRIVAL', { withdrawId: id });
        }
        const free = await venue.free(asset.symbol, 'fund');
        const amount = Math.min(free, c.assetAmount!);
        this.mark(c);
        const id = await venue.withdraw(asset.symbol, amount, wallet.address, assetNet.network).catch((e) => this.rejectIfDefinitive(c, e));
        return this.go(c, 'AWAIT_ARRIVAL', { withdrawId: id, assetAmount: amount - (Number.isFinite(assetNet.withdrawFee) ? assetNet.withdrawFee : 0) });
      }
      case 'AWAIT_ARRIVAL': {
        const arrived = (await wallet.balanceOf(asset.address)) - BigInt(c.walletBalBefore!);
        if (arrived >= (toUnits(c.assetAmount!, asset.decimals) * 98n) / 100n) {
          return this.go(c, 'DEX_SELL', { assetAmount: fromUnits(arrived, asset.decimals) });
        }
        const st = await venue.withdrawalStatus(asset.symbol, c.withdrawId!, c.createdAt - 60_000).catch(() => null);
        if (st && ['failed', 'canceled'].includes(st.status)) throw new Error(`withdrawal ${st.status} by exchange`);
        if (this.timedOut(c)) {
          this.notify.send(`⏳ ${c.id}: withdrawal ${c.withdrawId} not arrived yet (${st?.status ?? '?'})`);
          c.stepStartedAt = Date.now();
        }
        await sleep(8_000);
        return;
      }

      // ───────────── transfers wallet → CEX ─────────────
      case 'DEPOSIT': {
        if (!assetNet?.deposit) {
          if (this.timedOut(c)) throw new Error('deposits stay suspended — tokens are in the wallet');
          throw new Retryable();
        }
        if (c.inflight && !c.txHash) throw new Error('crashed while sending deposit — check wallet');
        if (!c.txHash) {
          const addr = await venue.depositAddress(asset.symbol, assetNet.network);
          c.cexBalBefore = await venue.free(asset.symbol, 'fund');
          this.mark(c);
          c.txHash = await wallet.sendErc20(asset.address, addr, toUnits(c.assetAmount!, asset.decimals));
          this.store.save(c);
        }
        await wallet.confirm(c.txHash);
        return this.go(c, 'AWAIT_CREDIT', { txHash: undefined });
      }
      case 'AWAIT_CREDIT': {
        const now = await venue.free(asset.symbol, 'fund');
        if (now - c.cexBalBefore! >= c.assetAmount! * 0.98) return this.go(c, 'TO_TRADE');
        if (this.timedOut(c)) {
          this.notify.send(`⏳ ${c.id}: deposit not credited yet on ${c.exchange}`);
          c.stepStartedAt = Date.now();
        }
        await sleep(8_000);
        return;
      }
      case 'TO_TRADE': {
        await venue.move(asset.symbol, c.assetAmount!, 'trade');
        return this.go(c, 'CEX_SELL');
      }

      // ───────────── second legs ─────────────
      case 'DEX_SELL': {
        if (c.inflight && !c.txHash) throw new Error('crashed while sending DEX sell — check wallet');
        let quoted = 0n;
        if (!c.txHash) {
          const minOut = await this.secondLegFloor(c);
          const r = await this.dex.swap(wallet, asset.address, chain.stable.address, toUnits(c.assetAmount!, asset.decimals), s.dexSlippageBps, minOut, () => this.mark(c));
          c.txHash = r.hash;
          c.dexSource = r.source;
          quoted = r.quotedOut;
          this.store.save(c);
        }
        const out = await wallet.receivedInTx(c.txHash, chain.stable.address);
        if (quoted) this.checkTax(c, out, quoted);
        const received = fromUnits(out, chain.stable.decimals);
        const next = c.hedgeQty ? 'HEDGE_CLOSE' : this.afterSecondLeg(c);
        return this.go(c, next, { quoteReceived: received, txHash: undefined, pnlUsd: received - c.quoteSpent! });
      }
      case 'CEX_SELL': {
        if (c.inflight) throw new Error('crashed during CEX sell — check order history manually');
        await this.secondLegFloor(c);
        const free = await venue.free(asset.symbol, 'trade');
        this.mark(c);
        const f = await venue.marketSell(asset.symbol, Math.min(free, c.assetAmount!)).catch((e) => this.rejectIfDefinitive(c, e));
        const received = f.cost - f.feeQuote;
        const next = c.hedgeQty ? 'HEDGE_CLOSE' : this.afterSecondLeg(c);
        return this.go(c, next, { quoteReceived: received, pnlUsd: received - c.quoteSpent! });
      }

      // ───────────── return stablecoins to restart the loop ─────────────
      case 'RETURN_DEPOSIT': {
        if (c.inflight && !c.txHash) throw new Error('crashed while sending stable back — check wallet');
        if (!c.txHash) {
          const addr = await venue.depositAddress(chain.stable.symbol, stableNet!.network);
          this.mark(c);
          c.txHash = await wallet.sendErc20(chain.stable.address, addr, toUnits(c.quoteReceived!, chain.stable.decimals));
          this.store.save(c);
        }
        await wallet.confirm(c.txHash);
        return this.go(c, 'DONE', { pnlUsd: c.pnlUsd! - chain.transferGasUsd, txHash: undefined });
      }
      case 'RETURN_WITHDRAW': {
        if (c.inflight) {
          const id = await venue.findWithdrawal(chain.stable.symbol, wallet.address, c.stepStartedAt - 60_000);
          if (!id) throw new Error('crashed during stable withdraw — verify manually');
          return this.go(c, 'DONE');
        }
        await venue.move(chain.stable.symbol, c.quoteReceived!, 'fund');
        const free = await venue.free(chain.stable.symbol, 'fund');
        const fee = Number.isFinite(stableNet!.withdrawFee) ? stableNet!.withdrawFee : 0;
        this.mark(c);
        await venue.withdraw(chain.stable.symbol, Math.min(free, c.quoteReceived!), wallet.address, stableNet!.network).catch((e) => this.rejectIfDefinitive(c, e));
        return this.go(c, 'DONE', { pnlUsd: c.pnlUsd! - fee });
      }
    }
  }

  /** Exchange explicitly rejected (not a timeout) → nothing happened, safe to fail/retry cleanly. */
  private rejectIfDefinitive(c: Cycle, e: unknown): never {
    if (e instanceof ccxt.ExchangeError && !(e instanceof ccxt.NetworkError)) {
      c.inflight = undefined;
      this.store.save(c);
    }
    throw e;
  }

  /**
   * Second-leg protection. Hedged cycles sell immediately (price risk is on the
   * perp). Unhedged: wait for a price no worse than `secondLegMaxLossBps` below
   * plan; after `secondLegMaxWaitMin` sell anyway to close the exposure.
   * Returns DEX min-out (stable units) for CEX_TO_DEX, 0 otherwise.
   */
  private async secondLegFloor(c: Cycle): Promise<bigint> {
    const { asset, chain, venue } = this.ctx(c);
    const s = this.cfg.strategy;
    let now: number;
    if (c.direction === 'CEX_TO_DEX') {
      const q = await this.dex.quote(chain, asset.address, chain.stable.address, toUnits(c.assetAmount!, asset.decimals));
      now = fromUnits(q.amountOut, chain.stable.decimals);
    } else {
      const book = venue.books.get(asset.symbol);
      if (!book) throw new Retryable();
      now = walkBids(book.bids, c.assetAmount!) ?? 0;
    }
    const floor = c.expectedOut * (1 - s.secondLegMaxLossBps / 1e4);
    if (!c.hedgeQty && now < floor) {
      if (Date.now() - c.stepStartedAt < s.secondLegMaxWaitMin * 60_000) {
        log.info('second leg below floor, waiting', { id: c.id, now, floor });
        throw new Retryable();
      }
      this.notify.send(`⚠️ ${c.id}: closing at a loss after waiting (${now.toFixed(2)} < ${floor.toFixed(2)})`);
    }
    return c.direction === 'CEX_TO_DEX' ? toUnits(now * (1 - s.dexSlippageBps / 1e4), chain.stable.decimals) : 0n;
  }
}
