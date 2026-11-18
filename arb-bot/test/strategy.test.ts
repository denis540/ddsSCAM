import { test } from 'node:test';
import assert from 'node:assert/strict';
import { walkBids, buyWithQuote, Curve, evalCexToDex, evalDexToCex, pickBest, type Costs } from '../src/core/strategy.js';
import { toUnits, fromUnits } from '../src/core/utils.js';
import type { Level } from '../src/cex/venue.js';

const bids: Level[] = [[1.0, 500], [0.99, 1000]];
const asks: Level[] = [[1.01, 500], [1.02, 1000]];
const costs: Costs = { takerFee: 0.001, withdrawFeeAsset: 1, withdrawFeeStable: 1, dexGasUsd: 0.1, transferGasUsd: 0.05, riskBufferBps: 30, autoReturn: true };

test('book walking', () => {
  assert.equal(walkBids(bids, 600), 500 + 100 * 0.99);
  assert.ok(Math.abs(buyWithQuote(asks, 505 + 102)! - 600) < 1e-9);
  assert.equal(walkBids(bids, 5000), null);
});

test('curve interpolates execution price and refuses far extrapolation', () => {
  const c = new Curve([{ in: 100, out: 110 }, { in: 300, out: 324 }]); // 1.10 -> 1.08
  assert.ok(Math.abs(c.out(200)! - 200 * 1.09) < 1e-9);
  assert.equal(c.out(400), null);
});

test('token cheap on CEX, expensive on DEX -> CEX_TO_DEX profitable', () => {
  const dexSell = new Curve([{ in: 100, out: 115 }, { in: 1000, out: 1140 }]); // DEX ~1.14-1.15
  const o = evalCexToDex(300, asks, dexSell, costs)!;
  const arrive = (300 / 1.01) * 0.999 - 1;
  assert.ok(Math.abs(o.expectedAssetMoved - arrive) < 1e-9);
  assert.ok(o.profitUsd > 30);
  assert.equal(pickBest([o], 5, 80), o);
});

test('token cheap on DEX -> DEX_TO_CEX profitable; no edge -> rejected', () => {
  const dexBuy = new Curve([{ in: 100, out: 110 }, { in: 1000, out: 1090 }]); // 1 USDT -> ~1.1 token
  const o = evalDexToCex(300, bids, dexBuy, costs)!;
  assert.ok(o.profitUsd > 20);
  const flat = new Curve([{ in: 100, out: 99 }, { in: 1000, out: 990 }]);
  assert.equal(pickBest([evalDexToCex(300, bids, flat, costs)], 5, 80), null);
});

test('unit conversions', () => {
  assert.equal(toUnits(1234.567891, 6), 1_234_567_891n);
  assert.equal(fromUnits(1_234_567_891n, 6), 1234.567891);
});
