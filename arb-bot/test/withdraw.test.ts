import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Venue, WithdrawBelowMin, type NetInfo } from '../src/cex/venue.js';

const net: NetInfo = { network: 'ARBITRUM', deposit: true, withdraw: true, withdrawFee: 1, withdrawMin: 5, depositMin: 0, contractOk: true };

test('fee deducted from amount (binance): withdraw all, receive amount − fee', () => {
  const v = new Venue('binance', 'USDT');
  assert.deepEqual(v.withdrawPlan('ARB', 100, 100, net), { amount: 100, minReceived: 99 });
});

test('fee on top (okx): keep fee in balance, receive full amount', () => {
  const v = new Venue('okx', 'USDT');
  assert.deepEqual(v.withdrawPlan('ARB', 100, 100, net), { amount: 99, minReceived: 99 });
});

test('unknown mode: conservative on both sides', () => {
  const v = new Venue('gate', 'USDT');
  assert.deepEqual(v.withdrawPlan('ARB', 100, 100, net), { amount: 99, minReceived: 98 });
});

test('config override wins', () => {
  assert.equal(new Venue('gate', 'USDT', 'extra').feeMode, 'extra');
});

test('below exchange minimum → refused before sending', () => {
  const v = new Venue('binance', 'USDT');
  assert.throws(() => v.withdrawPlan('ARB', 4, 4, net), WithdrawBelowMin);
});
