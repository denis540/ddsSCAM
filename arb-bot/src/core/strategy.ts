import type { Level } from '../cex/venue.js';

export type Direction = 'CEX_TO_DEX' | 'DEX_TO_CEX';

/** Sell `baseQty` into bids → gross quote, or null if the book is too thin. */
export function walkBids(bids: Level[], baseQty: number): number | null {
  let left = baseQty;
  let quote = 0;
  for (const [p, q] of bids) {
    const take = Math.min(left, q);
    quote += take * p;
    left -= take;
    if (left <= 1e-12) return quote;
  }
  return null;
}

/** Spend `quoteAmt` on asks → base received (gross), or null if the book is too thin. */
export function buyWithQuote(asks: Level[], quoteAmt: number): number | null {
  let left = quoteAmt;
  let base = 0;
  for (const [p, q] of asks) {
    const cost = Math.min(left, p * q);
    base += cost / p;
    left -= cost;
    if (left <= 1e-9) return base;
  }
  return null;
}

/**
 * DEX price curve from a few aggregator quotes: out(x) via linear
 * interpolation of the execution price. Beyond 10% over the largest probe → null.
 */
export class Curve {
  private pts: { x: number; px: number }[];
  constructor(points: { in: number; out: number }[]) {
    this.pts = points.filter((p) => p.in > 0 && p.out > 0).map((p) => ({ x: p.in, px: p.out / p.in })).sort((a, b) => a.x - b.x);
  }
  get empty() {
    return this.pts.length === 0;
  }
  out(x: number): number | null {
    const p = this.pts;
    if (!p.length || x <= 0) return null;
    if (x <= p[0].x) return x * p[0].px;
    for (let i = 1; i < p.length; i++) {
      if (x <= p[i].x) {
        const t = (x - p[i - 1].x) / (p[i].x - p[i - 1].x);
        return x * (p[i - 1].px + t * (p[i].px - p[i - 1].px));
      }
    }
    const last = p[p.length - 1];
    return x <= last.x * 1.1 ? x * last.px : null;
  }
}

export interface Costs {
  takerFee: number;
  withdrawFeeAsset: number; // CEX → wallet, in asset units
  withdrawFeeStable: number; // CEX → wallet for returning stable, in USD
  dexGasUsd: number;
  transferGasUsd: number; // ERC20 transfer (deposit to CEX)
  riskBufferBps: number;
  autoReturn: boolean;
  /** Perp open+close taker fees when the transfer is hedged (0 = unhedged). */
  hedgeFeeBps?: number;
}

export interface Opportunity {
  direction: Direction;
  sizeQuote: number;
  expectedAssetMoved: number; // tokens that travel between venues
  expectedOut: number; // final stable/quote received
  profitUsd: number;
  profitBps: number;
  costsUsd: number;
}

/** Buy on CEX → withdraw → sell on DEX (→ deposit stable back). */
export function evalCexToDex(size: number, asks: Level[], dexSell: Curve, c: Costs): Opportunity | null {
  const gross = buyWithQuote(asks, size);
  if (gross === null) return null;
  const bought = gross * (1 - c.takerFee);
  const arrive = bought - c.withdrawFeeAsset;
  if (arrive <= 0) return null;
  const out = dexSell.out(arrive);
  if (out === null) return null;
  const costs = c.dexGasUsd + (c.autoReturn ? c.transferGasUsd : 0) + (size * (c.riskBufferBps + (c.hedgeFeeBps ?? 0))) / 1e4;
  const profit = out - size - costs;
  return { direction: 'CEX_TO_DEX', sizeQuote: size, expectedAssetMoved: arrive, expectedOut: out, profitUsd: profit, profitBps: (profit / size) * 1e4, costsUsd: costs };
}

/** Buy on DEX → deposit to CEX → sell on CEX (→ withdraw stable back). */
export function evalDexToCex(size: number, bids: Level[], dexBuy: Curve, c: Costs): Opportunity | null {
  const tokens = dexBuy.out(size);
  if (tokens === null) return null;
  const gross = walkBids(bids, tokens);
  if (gross === null) return null;
  const out = gross * (1 - c.takerFee);
  const costs = c.dexGasUsd + c.transferGasUsd + (c.autoReturn ? c.withdrawFeeStable : 0) + (size * (c.riskBufferBps + (c.hedgeFeeBps ?? 0))) / 1e4;
  const profit = out - size - costs;
  return { direction: 'DEX_TO_CEX', sizeQuote: size, expectedAssetMoved: tokens, expectedOut: out, profitUsd: profit, profitBps: (profit / size) * 1e4, costsUsd: costs };
}

export function pickBest(ops: (Opportunity | null)[], minUsd: number, minBps: number): Opportunity | null {
  let best: Opportunity | null = null;
  for (const o of ops) if (o && o.profitUsd >= minUsd && o.profitBps >= minBps && (!best || o.profitUsd > best.profitUsd)) best = o;
  return best;
}
