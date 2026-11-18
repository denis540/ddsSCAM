import fs from 'node:fs';
import path from 'node:path';

const HEADER = 'time,mode,id,exchange,asset,chain,direction,size_usd,expected_usd,realized_usd,hedge_usd,minutes,dex_source,note\n';

export interface JournalRow {
  mode: 'live' | 'paper';
  id: string;
  exchange: string;
  asset: string;
  chain: string;
  direction: string;
  sizeUsd: number;
  expectedUsd: number;
  realizedUsd: number;
  hedgeUsd?: number;
  minutes: number;
  dexSource?: string;
  note?: string;
}

/** Append-only CSV of every finished cycle (live and paper) — open it in Excel/Sheets. */
export class Journal {
  constructor(private file = 'data/journal.csv') {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (!fs.existsSync(file)) fs.writeFileSync(file, HEADER);
  }

  add(r: JournalRow) {
    const cells = [new Date().toISOString(), r.mode, r.id, r.exchange, r.asset, r.chain, r.direction, r.sizeUsd.toFixed(2), r.expectedUsd.toFixed(2),
      r.realizedUsd.toFixed(2), (r.hedgeUsd ?? 0).toFixed(2), r.minutes.toFixed(1), r.dexSource ?? '', (r.note ?? '').replace(/[,\n]/g, ' ')];
    fs.appendFileSync(this.file, cells.join(',') + '\n');
  }

  /** Totals by mode for a time window. */
  summary(sinceMs: number) {
    const out: Record<string, { n: number; pnl: number; wins: number }> = {};
    for (const line of fs.readFileSync(this.file, 'utf8').split('\n').slice(1)) {
      const c = line.split(',');
      if (c.length < 10 || Date.parse(c[0]) < sinceMs) continue;
      const k = c[1];
      const pnl = Number(c[9]) + Number(c[10]);
      out[k] ??= { n: 0, pnl: 0, wins: 0 };
      out[k].n++;
      out[k].pnl += pnl;
      if (pnl > 0) out[k].wins++;
    }
    return out;
  }
}

/** Tokens that misbehave (transfer tax, honeypot, wrong contract) — persisted, never traded again. */
export class Blacklist {
  private set: Set<string>;
  constructor(private file = 'data/blacklist.json') {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.set = new Set(fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, 'utf8')) as string[]) : []);
  }
  has(symbol: string, chain: string) {
    return this.set.has(`${symbol}:${chain}`);
  }
  add(symbol: string, chain: string) {
    this.set.add(`${symbol}:${chain}`);
    fs.writeFileSync(this.file, JSON.stringify([...this.set], null, 1));
  }
}
