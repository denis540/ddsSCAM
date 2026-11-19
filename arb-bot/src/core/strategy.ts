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
  range(): { minX: number; maxX: number; firstPx: number } | null {
    const p = this.pts;
    return p.length ? { minX: p[0].x, maxX: p[p.length - 1].x, firstPx: p[0].px } : null;
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

// ─────────── Auto-sizing by order-book slippage ───────────

/** Max quote to spend on asks so the average fill stays within `slip` of the best ask. */
export function maxQuoteWithinSlippage(asks: Level[], slip: number): number {
  if (!asks.length) return 0;
  const limit = asks[0][0] * (1 + slip);
  let base = 0;
  let cost = 0;
  for (const [p, q] of asks) {
    if (p <= limit) {
      base += q;
      cost += p * q;
      continue;
    }
    // partial level: (cost + p·x) / (base + x) ≤ limit
    const x = Math.min(q, Math.max(0, (limit * base - cost) / (p - limit)));
    return cost + p * x;
  }
  return cost; // whole visible book is within slippage
}

/** Max base to sell into bids so the average fill stays within `slip` of the best bid. */
export function maxBaseWithinSlippage(bids: Level[], slip: number): number {
  if (!bids.length) return 0;
  const limit = bids[0][0] * (1 - slip);
  let base = 0;
  let quote = 0;
  for (const [p, q] of bids) {
    if (p >= limit) {
      base += q;
      quote += p * q;
      continue;
    }
    // (quote + p·x) / (base + x) ≥ limit
    const x = Math.min(q, Math.max(0, (quote - limit * base) / (limit - p)));
    return base + x;
  }
  return base;
}

/** Largest DEX input whose execution price is within `slip` of the smallest-size price. */
export function maxDexInWithinImpact(c: Curve, slip: number): number {
  const r = c.range();
  if (!r) return 0;
  const ref = r.firstPx * (1 - slip);
  const px = (x: number) => c.out(x)! / x;
  if (px(r.maxX) >= ref) return r.maxX;
  let lo = r.minX;
  let hi = r.maxX;
  if (px(lo) < ref) return 0;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (px(mid) >= ref) lo = mid;
    else hi = mid;
  }
  return lo;
}

/** Geometric ladder: more points at small sizes where most edges live. */
export function geoLadder(min: number, max: number, n: number): number[] {
  if (max <= min || n <= 1) return [Math.max(min, max)];
  const k = Math.pow(max / min, 1 / (n - 1));
  return Array.from({ length: n }, (_, i) => min * Math.pow(k, i));
}
