import type { Config } from '../config.js';
import type { Venue } from '../cex/venue.js';
import type { ChainWallet } from '../chain/wallet.js';
import type { CycleStore, Cycle } from './store.js';
import { log, errMsg } from './logger.js';
import { fromUnits } from './utils.js';

/**
 * Capital allocation per funding source:
 *   cex:<exchange> — USDT on the exchange's spot account (pays CEX_TO_DEX)
 *   chain:<chain>  — stablecoin in the bot wallet (pays DEX_TO_CEX)
 *
 * One cycle may use at most `capitalFraction` of the source's equity
 * (free balance + money already committed to active cycles from it).
 * With fraction 0.5 and maxConcurrentCycles 2: two coins, 50% each.
 */
export class Capital {
  private free = new Map<string, number>();
  private updatedAt = 0;

  constructor(
    private cfg: Config,
    private venues: Map<string, Venue>,
    private wallets: Map<string, ChainWallet>,
    private store: CycleStore,
  ) {}

  static cexKey(ex: string) {
    return `cex:${ex}`;
  }
  static chainKey(chain: string) {
    return `chain:${chain}`;
  }
  static sourceOf(c: Pick<Cycle, 'direction' | 'exchange' | 'chain'>) {
    return c.direction === 'CEX_TO_DEX' ? Capital.cexKey(c.exchange) : Capital.chainKey(c.chain);
  }

  async refresh(force = false) {
    if (!force && Date.now() - this.updatedAt < 30_000) return;
    this.updatedAt = Date.now();
    const paper = this.cfg.strategy.sizing.paperCapitalQuote;
    await Promise.all([
      ...[...this.venues.values()].map(async (v) => {
        const k = Capital.cexKey(v.id);
        if (this.cfg.dryRun || !v.hasKeys) return void this.free.set(k, paper);
        try {
          this.free.set(k, await v.free(this.cfg.quote, 'trade'));
        } catch (e) {
          log.warn('capital refresh failed', { source: k, err: errMsg(e) });
        }
      }),
      ...[...this.wallets.entries()].map(async ([name, w]) => {
        const k = Capital.chainKey(name);
        if (this.cfg.dryRun || !w.account) return void this.free.set(k, paper);
        try {
          this.free.set(k, fromUnits(await w.balanceOf(w.cfg.stable.address), w.cfg.stable.decimals));
        } catch (e) {
          log.warn('capital refresh failed', { source: k, err: errMsg(e) });
        }
      }),
    ]);
  }

  /** Max size for a new cycle funded from `source`. */
  capFor(source: string): number {
    const active = this.store.active().filter((c) => Capital.sourceOf(c) === source);
    // cycles still in their first leg have not spent their money yet → not in balance deltas
    const pending = active.filter((c) => c.step === 'CEX_BUY' || c.step === 'DEX_BUY').reduce((s, c) => s + c.sizeQuote, 0);
    const committed = active.reduce((s, c) => s + c.sizeQuote, 0);
    const available = Math.max(0, (this.free.get(source) ?? 0) - pending);
    const equity = available + committed;
    return Math.min(available, equity * this.cfg.strategy.sizing.capitalFraction);
  }

  maxCap(): number {
    let m = 0;
    for (const k of this.free.keys()) m = Math.max(m, this.capFor(k));
    return m;
  }
}
