import type { Level } from '../cex/binance.js';
import { floorToStep } from './utils.js';

export type Direction = 'DEX_BUY_CEX_SELL' | 'CEX_BUY_DEX_SELL';

/** Sell `baseQty` into bids. Returns gross quote received, or null if book too thin. */
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

/** Buy `baseQty` from asks. Returns gross quote cost, or null if book too thin. */
export function walkAsks(asks: Level[], baseQty: number): number | null {
  let left = baseQty;
  let cost = 0;
  for (const [p, q] of asks) {
    const take = Math.min(left, q);
    cost += take * p;
    left -= take;
    if (left <= 1e-12) return cost;
  }
  return null;
}

export interface Evaluation {
  direction: Direction;
  sizeQuote: number; // notional in quote currency
  dexIn: number; // amount sent into the DEX (quote for BUY, base for SELL)
  dexOut: number; // expected DEX output (base for BUY, quote for SELL)
  cexBaseQty: number; // qty for the CEX hedge
  cexQuote: number; // CEX proceeds (sell) or cost (buy) incl. taker fee
  gasUsd: number;
  profitUsd: number;
  profitBps: number;
}

export interface CostParams {
  takerFee: number;
  stepSize: number;
  minQty: number;
  minNotional: number;
  gasUsd: number;
}

/** DEX: spend `quoteIn` -> receive `baseOut`; CEX: sell base into bids. */
export function evalDexBuy(quoteIn: number, baseOut: number, bids: Level[], p: CostParams): Evaluation | null {
  const qty = floorToStep(baseOut, p.stepSize);
  if (qty < p.minQty || bids.length === 0) return null;
  const gross = walkBids(bids, qty);
  if (gross === null || gross < p.minNotional) return null;
  const net = gross * (1 - p.takerFee);
  const dust = (baseOut - qty) * bids[0][0]; // remainder stays in inventory, marked at best bid
  const profit = net + dust - quoteIn - p.gasUsd;
  return {
    direction: 'DEX_BUY_CEX_SELL',
    sizeQuote: quoteIn,
    dexIn: quoteIn,
    dexOut: baseOut,
    cexBaseQty: qty,
    cexQuote: net,
    gasUsd: p.gasUsd,
    profitUsd: profit,
    profitBps: (profit / quoteIn) * 1e4,
  };
}

/** DEX: sell `baseIn` -> receive `quoteOut`; CEX: buy the same base back from asks. */
export function evalDexSell(baseIn: number, quoteOut: number, asks: Level[], p: CostParams): Evaluation | null {
  if (baseIn < p.minQty || asks.length === 0) return null;
  const gross = walkAsks(asks, baseIn);
  if (gross === null || gross < p.minNotional) return null;
  const cost = gross * (1 + p.takerFee);
  const profit = quoteOut - cost - p.gasUsd;
  return {
    direction: 'CEX_BUY_DEX_SELL',
    sizeQuote: gross,
    dexIn: baseIn,
    dexOut: quoteOut,
    cexBaseQty: baseIn,
    cexQuote: cost,
    gasUsd: p.gasUsd,
    profitUsd: profit,
    profitBps: (profit / gross) * 1e4,
  };
}

/** Evenly spaced trade sizes between min and max (inclusive). */
export function sizeLadder(min: number, max: number, steps: number): number[] {
  if (steps <= 1 || max <= min) return [max];
  const out: number[] = [];
  for (let i = 0; i < steps; i++) out.push(min + ((max - min) * i) / (steps - 1));
  return out;
}

export function pickBest(evals: (Evaluation | null)[], minProfitUsd: number, minProfitBps: number): Evaluation | null {
  let best: Evaluation | null = null;
  for (const e of evals) {
    if (!e || e.profitUsd < minProfitUsd || e.profitBps < minProfitBps) continue;
    if (!best || e.profitUsd > best.profitUsd) best = e;
  }
  return best;
}
