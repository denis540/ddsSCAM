import fs from 'node:fs';
import type { Config } from '../config.js';
import type { Venue } from '../cex/venue.js';
import type { ChainWallet } from '../chain/wallet.js';
import type { CycleStore } from './store.js';
import type { Journal } from './journal.js';
import type { RiskManager } from './risk.js';
import type { Notifier } from './notifier.js';
import ccxt from 'ccxt';
import { log, errMsg } from './logger.js';
import { fromUnits } from './utils.js';

/** Accounts to sum per exchange (ccxt fetchBalance `type`) — no overlaps. */
const EQUITY_ACCOUNTS: Record<string, string[]> = {
  binance: ['spot', 'funding', 'future'],
  okx: ['funding', 'trading'],
  bybit: ['funding', 'unified'],
  kucoin: ['main', 'trade'],
  gate: ['spot', 'swap'],
  bitget: ['spot', 'swap'],
};
const USD_LIKE = new Set(['USDT', 'USDC', 'FDUSD', 'DAI', 'USDE']);
const RETURN_IN_FLIGHT_MS = 45 * 60_000;

export interface Snapshot {
  at: number;
  totalUsd: number;
  parts: Record<string, number>;
}

/**
 * Reconciliation: total money everywhere (exchanges + wallets + coins in transit
 * + perp PnL) must match start equity + realized PnL of finished cycles.
 * A gap means stuck funds, a bug, or a compromised key → alert / halt.
 */
export class EquityMonitor {
  private baseline: { at: number; usd: number } | null = null;
  last: Snapshot | null = null;
  private lastAlert = 0;
  /** Account types the exchange rejects (e.g. futures not enabled) — skipped after first error. */
  private unsupported = new Set<string>();

  constructor(
    private cfg: Config,
    private venues: Map<string, Venue>,
    private wallets: Map<string, ChainWallet>,
    private store: CycleStore,
    private journal: Journal,
    private risk: RiskManager,
    private notify: Notifier,
    private file = 'data/equity.json',
  ) {
    if (fs.existsSync(file)) this.baseline = JSON.parse(fs.readFileSync(file, 'utf8'));
  }

  private price(sym: string): number | undefined {
    if (USD_LIKE.has(sym)) return 1;
    for (const v of this.venues.values()) {
      const b = v.books.get(sym);
      if (b?.bids.length && b.asks.length) return (b.bids[0][0] + b.asks[0][0]) / 2;
    }
    return undefined;
  }

  async snapshot(): Promise<Snapshot> {
    const parts: Record<string, number> = {};
    const add = (k: string, usd: number) => (parts[k] = (parts[k] ?? 0) + usd);
    const known = new Set([...this.cfg.assets.map((a) => a.symbol), ...USD_LIKE]);

    for (const v of this.venues.values()) {
      for (const type of EQUITY_ACCOUNTS[v.id] ?? ['spot']) {
        const key = `${v.id}:${type}`;
        if (this.unsupported.has(key)) continue;
        let b: any;
        try {
          b = await v.ex.fetchBalance({ type });
        } catch (e) {
          if (e instanceof ccxt.NetworkError) throw e; // transient → whole snapshot skipped
          this.unsupported.add(key);
          log.warn('equity: account type not available, skipping', { account: key, err: errMsg(e) });
          continue;
        }
        for (const [code, amt] of Object.entries<any>(b.total ?? {})) {
          const n = Number(amt);
          if (!n || !known.has(code)) continue;
          const px = this.price(code);
          if (px) add(`${v.id}`, n * px);
        }
      }
    }
    // unrealized PnL of open hedges (wallet balance of futures accounts excludes it on some venues)
    const hedgeVenues = new Set(this.store.active().filter((c) => c.hedgeQty).map((c) => c.hedgeVenue!));
    for (const id of hedgeVenues) {
      const v = this.venues.get(id)!;
      const pos = await v.ex.fetchPositions();
      for (const p of pos) add(`${id}:upnl`, Number(p.unrealizedPnl ?? 0));
    }
    for (const [name, w] of this.wallets) {
      if (!w.account) continue;
      add(`wallet:${name}`, fromUnits(await w.balanceOf(w.cfg.stable.address), w.cfg.stable.decimals));
      for (const a of this.cfg.assets.filter((x) => x.chain === name)) {
        const px = this.price(a.symbol);
        const bal = fromUnits(await w.balanceOf(a.address), a.decimals);
        if (px && bal) add(`wallet:${name}`, bal * px);
      }
    }
    // coins travelling between venues
    for (const c of this.store.active()) {
      const travelling =
        c.step === 'AWAIT_ARRIVAL' || c.step === 'AWAIT_CREDIT' || (c.step === 'WITHDRAW' && c.inflight) || (c.step === 'DEPOSIT' && c.inflight);
      const px = this.price(c.asset);
      if (travelling && px && c.assetAmount) add('in_transit', c.assetAmount * px);
    }
    // stablecoins returned but maybe not yet credited
    for (const c of this.store.all()) {
      if (c.step === 'DONE' && c.returnSentAt && Date.now() - c.returnSentAt < RETURN_IN_FLIGHT_MS) add('in_transit', c.quoteReceived ?? 0);
    }
    const totalUsd = Object.values(parts).reduce((s, x) => s + x, 0);
    return { at: Date.now(), totalUsd, parts };
  }

  /** Set the current equity as the new reference (after you deposit/withdraw money yourself). */
  async rebase(): Promise<number> {
    const s = await this.snapshot();
    this.baseline = { at: s.at, usd: s.totalUsd };
    fs.writeFileSync(this.file, JSON.stringify(this.baseline));
    this.last = s;
    return s.totalUsd;
  }

  async check(): Promise<string> {
    if (this.cfg.dryRun) return 'equity check is live-only';
    let s: Snapshot;
    try {
      s = await this.snapshot();
    } catch (e) {
      log.warn('equity snapshot incomplete, skipped', { err: errMsg(e) });
      return `snapshot failed: ${errMsg(e)}`;
    }
    this.last = s;
    if (!this.baseline) {
      await this.rebase();
      log.info('equity baseline set', { usd: s.totalUsd });
      return `baseline set: ${s.totalUsd.toFixed(2)}$`;
    }
    const realized = this.journal.summary(this.baseline.at).live?.pnl ?? 0;
    const expected = this.baseline.usd + realized;
    const gapPct = ((expected - s.totalUsd) / expected) * 100;
    const r = this.cfg.risk.equity;
    const msg = `equity ${s.totalUsd.toFixed(2)}$ vs expected ${expected.toFixed(2)}$ (gap ${gapPct.toFixed(2)}%)`;
    log.info('equity', { total: +s.totalUsd.toFixed(2), expected: +expected.toFixed(2), gapPct: +gapPct.toFixed(2), parts: s.parts });
    if (gapPct >= r.haltDropPct) {
      this.risk.halt(`equity gap ${gapPct.toFixed(2)}%`);
      this.notify.send(`🛑 ${msg} — new cycles STOPPED. Check balances, then /equity reset and /resume`);
    } else if (gapPct >= r.alertDropPct && Date.now() - this.lastAlert > 60 * 60_000) {
      this.lastAlert = Date.now();
      this.notify.send(`⚠️ ${msg}`);
    }
    return msg;
  }

  start() {
    if (this.cfg.dryRun) return;
    const tick = () => void this.check();
    setTimeout(tick, 60_000); // books need a minute to fill for valuation
    setInterval(tick, this.cfg.risk.equity.checkEveryMin * 60_000).unref();
  }
}
