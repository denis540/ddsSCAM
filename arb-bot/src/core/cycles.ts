import ccxt from 'ccxt';
import type { Config, AssetCfg, ChainCfg } from '../config.js';
import type { Venue } from '../cex/venue.js';
import type { ChainWallet } from '../chain/wallet.js';
import type { Kyber } from '../chain/kyber.js';
import { CycleStore, type Cycle, type Step } from './store.js';
import { RiskManager } from './risk.js';
import { Notifier } from './notifier.js';
import { log, errMsg } from './logger.js';
import { fromUnits, toUnits, sleep } from './utils.js';

class Retryable extends Error {}

/**
 * Executes transfer-arbitrage cycles as a persisted state machine:
 *
 *  CEX_TO_DEX: CEX_BUY → TO_FUND → WITHDRAW → AWAIT_ARRIVAL → DEX_SELL → RETURN_DEPOSIT → DONE
 *  DEX_TO_CEX: DEX_BUY → DEPOSIT → AWAIT_CREDIT → TO_TRADE → CEX_SELL → RETURN_WITHDRAW → DONE
 *
 * Every money-moving call is marked `inflight` before it is sent. If the process
 * dies in between, the cycle is NOT blindly repeated: it is either recovered from
 * exchange/chain history or parked as NEEDS_ATTENTION with an alert.
 */
export class CycleRunner {
  private running = new Set<string>();

  constructor(
    private cfg: Config,
    private store: CycleStore,
    private venues: Map<string, Venue>,
    private wallets: Map<string, ChainWallet>,
    private kyber: Kyber,
    private risk: RiskManager,
    private notify: Notifier,
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
            if (e instanceof Retryable) {
              await sleep(5000);
              continue;
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
    // Before any funds moved, failure is clean; after that, a human must look.
    const clean = c.step === 'CEX_BUY' || c.step === 'DEX_BUY';
    c.step = clean && !c.inflight ? 'FAILED' : 'NEEDS_ATTENTION';
    c.error = error;
    this.store.save(c);
    this.risk.recordFailure(c.gasUsd ?? 0);
    log.error('cycle stopped', { id: c.id, step: c.step, error });
    this.notify.send(`${c.step === 'FAILED' ? '❌' : '🚨'} ${c.id} ${c.direction} ${c.asset}@${c.exchange}: ${error}`);
  }

  private finish(c: Cycle) {
    this.risk.recordTrade(c.pnlUsd ?? 0);
    const msg = `✅ ${c.direction} ${c.asset}@${c.exchange} size ${c.sizeQuote}$ pnl ${c.pnlUsd?.toFixed(2)}$ (exp ${c.expectedProfitUsd.toFixed(2)}$) in ${((c.updatedAt - c.createdAt) / 60000).toFixed(1)} min`;
    log.info('CYCLE DONE', { id: c.id, pnl: c.pnlUsd, expected: c.expectedProfitUsd });
    this.notify.send(msg);
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

  private async step(c: Cycle): Promise<void> {
    const { asset, chain, venue, wallet } = this.ctx(c);
    const assetNet = venue.net.get(`${asset.symbol}:${chain.name}`);
    const stableNet = venue.net.get(`${chain.stable.symbol}:${chain.name}`);

    switch (c.step) {
      // ───────────── CEX → DEX ─────────────
      case 'CEX_BUY': {
        if (c.inflight) throw new Error('crashed during CEX buy — check order history manually');
        const book = venue.books.get(asset.symbol);
        if (!book) throw new Error('no order book');
        this.mark(c);
        const f = await venue.marketBuyWithQuote(asset.symbol, c.sizeQuote, book.asks[0][0]).catch((e) => this.rejectIfDefinitive(c, e));
        if (f.filled <= 0) throw new Error(`buy not filled (order ${f.id})`);
        return this.go(c, 'TO_FUND', { assetAmount: f.filled - f.feeBase, quoteSpent: f.cost + f.feeQuote });
      }
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
        const id = await venue.withdraw(asset.symbol, amount, wallet.address, assetNet.network);
        return this.go(c, 'AWAIT_ARRIVAL', { withdrawId: id, assetAmount: amount - (Number.isFinite(assetNet.withdrawFee) ? assetNet.withdrawFee : 0) });
      }
      case 'AWAIT_ARRIVAL': {
        const now = await wallet.balanceOf(asset.address);
        const arrived = now - BigInt(c.walletBalBefore!);
        const expected = toUnits(c.assetAmount!, asset.decimals);
        if (arrived >= (expected * 98n) / 100n) {
          return this.go(c, 'DEX_SELL', { assetAmount: fromUnits(arrived, asset.decimals) });
        }
        const st = await venue.withdrawalStatus(asset.symbol, c.withdrawId!, c.createdAt - 60_000).catch(() => null);
        if (st && ['failed', 'canceled'].includes(st.status)) throw new Error(`withdrawal ${st.status} by exchange`);
        if (this.timedOut(c)) this.notify.send(`⏳ ${c.id}: withdrawal ${c.withdrawId} still not arrived (${st?.status ?? '?'})`), (c.stepStartedAt = Date.now());
        await sleep(10_000);
        return;
      }
      case 'DEX_SELL': {
        if (c.inflight && !c.txHash) throw new Error('crashed while sending DEX sell — check wallet');
        if (!c.txHash) {
          const amountIn = toUnits(c.assetAmount!, asset.decimals);
          const minOut = await this.secondLegFloor(c, chain.stable.decimals);
          const { hash } = await this.kyber.swap(wallet, asset.address, chain.stable.address, amountIn, this.cfg.strategy.dexSlippageBps, minOut, () => this.mark(c));
          c.txHash = hash;
          this.store.save(c);
        }
        const out = await wallet.receivedInTx(c.txHash, chain.stable.address);
        const received = fromUnits(out, chain.stable.decimals);
        const next = this.cfg.strategy.autoReturn && chain.stable.symbol === this.cfg.quote && stableNet?.deposit ? 'RETURN_DEPOSIT' : 'DONE';
        return this.go(c, next, { quoteReceived: received, txHash: undefined, pnlUsd: received - c.quoteSpent! });
      }
      case 'RETURN_DEPOSIT': {
        if (c.inflight && !c.txHash) throw new Error('crashed while sending stable back — check wallet');
        if (!c.txHash) {
          const addr = await venue.depositAddress(chain.stable.symbol, stableNet!.network);
          this.mark(c);
          c.txHash = await wallet.sendErc20(chain.stable.address, addr, toUnits(c.quoteReceived!, chain.stable.decimals));
          this.store.save(c);
        }
        await wallet.confirm(c.txHash);
        return this.go(c, 'DONE', { pnlUsd: c.pnlUsd! - chain.transferGasUsd });
      }

      // ───────────── DEX → CEX ─────────────
      case 'DEX_BUY': {
        if (c.inflight && !c.txHash) throw new Error('crashed while sending DEX buy — check wallet');
        if (!c.txHash) {
          const amountIn = toUnits(c.sizeQuote, chain.stable.decimals);
          const { hash } = await this.kyber.swap(wallet, chain.stable.address, asset.address, amountIn, this.cfg.strategy.dexSlippageBps, 0n, () => this.mark(c));
          c.txHash = hash;
          this.store.save(c);
        }
        const got = await wallet.receivedInTx(c.txHash, asset.address);
        return this.go(c, 'DEPOSIT', { assetAmount: fromUnits(got, asset.decimals), quoteSpent: c.sizeQuote, txHash: undefined });
      }
      case 'DEPOSIT': {
        if (!assetNet?.deposit) {
          if (this.timedOut(c)) throw new Error('deposits stay suspended — tokens are in the wallet');
          throw new Retryable();
        }
        if (c.inflight && !c.txHash) throw new Error('crashed while sending deposit — check wallet');
        if (!c.txHash) {
          const addr = await venue.depositAddress(asset.symbol, assetNet.network);
          const before = await venue.free(asset.symbol, 'fund');
          c.cexBalBefore = before;
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
        if (this.timedOut(c)) this.notify.send(`⏳ ${c.id}: deposit not credited yet on ${c.exchange}`), (c.stepStartedAt = Date.now());
        await sleep(10_000);
        return;
      }
      case 'TO_TRADE': {
        await venue.move(asset.symbol, c.assetAmount!, 'trade');
        return this.go(c, 'CEX_SELL');
      }
      case 'CEX_SELL': {
        if (c.inflight) throw new Error('crashed during CEX sell — check order history manually');
        await this.secondLegFloor(c, 0);
        const free = await venue.free(asset.symbol, 'trade');
        this.mark(c);
        const f = await venue.marketSell(asset.symbol, Math.min(free, c.assetAmount!));
        const received = f.cost - f.feeQuote;
        const next = this.cfg.strategy.autoReturn && chain.stable.symbol === this.cfg.quote && stableNet?.withdraw ? 'RETURN_WITHDRAW' : 'DONE';
        return this.go(c, next, { quoteReceived: received, pnlUsd: received - c.quoteSpent! });
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
        await venue.withdraw(chain.stable.symbol, Math.min(free, c.quoteReceived!), wallet.address, stableNet!.network);
        return this.go(c, 'DONE', { pnlUsd: c.pnlUsd! - fee });
      }
    }
  }

  /** Exchange explicitly rejected the order (not a timeout) → nothing happened, safe to fail cleanly. */
  private rejectIfDefinitive(c: Cycle, e: unknown): never {
    if (e instanceof ccxt.ExchangeError && !(e instanceof ccxt.NetworkError)) {
      c.inflight = undefined;
      this.store.save(c);
    }
    throw e;
  }

  /**
   * Second leg protection: the price may have moved while coins travelled.
   * Wait for a price no worse than `secondLegMaxLossBps` below plan; after
   * `secondLegMaxWaitMin` sell anyway to close the exposure.
   * Returns the min-out (in stable units) for DEX legs.
   */
  private async secondLegFloor(c: Cycle, stableDecimals: number): Promise<bigint> {
    const { asset, chain, venue } = this.ctx(c);
    const s = this.cfg.strategy;
    const floor = c.expectedOut * (1 - s.secondLegMaxLossBps / 1e4);
    const waited = Date.now() - c.stepStartedAt;
    let now: number;
    if (c.direction === 'CEX_TO_DEX') {
      const q = await this.kyber.quote(chain.kyberSlug, asset.address, chain.stable.address, toUnits(c.assetAmount!, asset.decimals));
      now = fromUnits(q.amountOut, stableDecimals);
    } else {
      const book = venue.books.get(asset.symbol);
      if (!book) throw new Retryable();
      let left = c.assetAmount!;
      now = 0;
      for (const [p, q] of book.bids) {
        const t = Math.min(left, q);
        now += t * p;
        left -= t;
        if (left <= 0) break;
      }
    }
    if (now < floor && waited < s.secondLegMaxWaitMin * 60_000) {
      log.info('second leg below floor, waiting', { id: c.id, now, floor });
      throw new Retryable();
    }
    if (now < floor) this.notify.send(`⚠️ ${c.id}: closing at a loss after waiting (${now.toFixed(2)} < ${floor.toFixed(2)})`);
    return stableDecimals ? toUnits(now * (1 - s.dexSlippageBps / 1e4), stableDecimals) : 0n;
  }
}

export type { AssetCfg, ChainCfg };
