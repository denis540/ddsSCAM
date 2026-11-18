import fs from 'node:fs';
import path from 'node:path';
import type { Direction } from './strategy.js';

export type Step =
  // CEX_TO_DEX
  | 'CEX_BUY' | 'TO_FUND' | 'WITHDRAW' | 'AWAIT_ARRIVAL' | 'DEX_SELL' | 'RETURN_DEPOSIT'
  // DEX_TO_CEX
  | 'DEX_BUY' | 'DEPOSIT' | 'AWAIT_CREDIT' | 'TO_TRADE' | 'CEX_SELL' | 'RETURN_WITHDRAW'
  | 'DONE' | 'FAILED' | 'NEEDS_ATTENTION';

export interface Cycle {
  id: string;
  direction: Direction;
  exchange: string;
  asset: string;
  chain: string;
  sizeQuote: number;
  expectedProfitUsd: number;
  expectedOut: number;
  step: Step;
  /** Set right before a money-moving call; cleared when its result is persisted. */
  inflight?: Step;
  createdAt: number;
  updatedAt: number;
  stepStartedAt: number;
  // step data
  assetAmount?: number; // tokens currently travelling / held for the cycle
  walletBalBefore?: string; // bigint as string
  cexBalBefore?: number;
  withdrawId?: string;
  txHash?: `0x${string}`;
  quoteSpent?: number;
  quoteReceived?: number;
  gasUsd?: number;
  pnlUsd?: number;
  error?: string;
}

/** Durable cycle state: written atomically on every step so a crash/restart resumes exactly. */
export class CycleStore {
  private cycles = new Map<string, Cycle>();
  constructor(private file = 'data/cycles.json') {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (fs.existsSync(file)) for (const c of JSON.parse(fs.readFileSync(file, 'utf8')) as Cycle[]) this.cycles.set(c.id, c);
  }

  active(): Cycle[] {
    return [...this.cycles.values()].filter((c) => !['DONE', 'FAILED', 'NEEDS_ATTENTION'].includes(c.step));
  }
  attention(): Cycle[] {
    return [...this.cycles.values()].filter((c) => c.step === 'NEEDS_ATTENTION');
  }

  save(c: Cycle) {
    c.updatedAt = Date.now();
    this.cycles.set(c.id, c);
    // keep file small: drop finished cycles older than 7 days
    const cutoff = Date.now() - 7 * 864e5;
    const all = [...this.cycles.values()].filter((x) => !(['DONE', 'FAILED'].includes(x.step) && x.updatedAt < cutoff));
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(all, null, 1));
    fs.renameSync(tmp, this.file);
  }
}
