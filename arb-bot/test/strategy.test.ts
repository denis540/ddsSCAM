import { test } from 'node:test';
import assert from 'node:assert/strict';
import { walkBids, walkAsks, evalDexBuy, evalDexSell, sizeLadder, pickBest } from '../src/core/strategy.js';
import { floorToStep, toUnits, fromUnits } from '../src/core/utils.js';
import type { Level } from '../src/cex/binance.js';

const bids: Level[] = [[3000, 1], [2999, 2]];
const asks: Level[] = [[3001, 1], [3002, 2]];
const p = { takerFee: 0.001, stepSize: 0.0001, minQty: 0.0001, minNotional: 5, gasUsd: 0.05 };

test('walk book across levels', () => {
  assert.equal(walkBids(bids, 1.5), 3000 + 0.5 * 2999);
  assert.equal(walkAsks(asks, 2), 3001 + 3002);
  assert.equal(walkBids(bids, 10), null);
});

test('DEX cheaper -> buy on DEX, sell on CEX is profitable', () => {
  // spend 2950 USDC on DEX, get 1 ETH (DEX price 2950), sell at 3000 bid
  const e = evalDexBuy(2950, 1, bids, p)!;
  assert.equal(e.direction, 'DEX_BUY_CEX_SELL');
  assert.ok(Math.abs(e.profitUsd - (3000 * 0.999 - 2950 - 0.05)) < 1e-9);
});

test('no edge -> negative profit after fees', () => {
  const e = evalDexBuy(3000, 1, bids, p)!;
  assert.ok(e.profitUsd < 0);
  assert.equal(pickBest([e], 1, 5), null);
});

test('DEX expensive -> sell on DEX, buy on CEX', () => {
  const e = evalDexSell(1, 3050, asks, p)!;
  assert.ok(Math.abs(e.profitUsd - (3050 - 3001 * 1.001 - 0.05)) < 1e-9);
  assert.equal(pickBest([e], 1, 5), e);
});

test('utils', () => {
  assert.equal(floorToStep(0.123456, 0.0001), 0.1234);
  assert.equal(toUnits(1.5, 18), 1_500_000_000_000_000_000n);
  assert.equal(toUnits(1234.567891, 6), 1_234_567_891n);
  assert.equal(fromUnits(1_234_567_891n, 6), 1234.567891);
  assert.deepEqual(sizeLadder(100, 500, 5), [100, 200, 300, 400, 500]);
});
