import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Curve, maxQuoteWithinSlippage, maxBaseWithinSlippage, maxDexInWithinImpact, geoLadder, buyWithQuote, walkBids } from '../src/core/strategy.js';
import { Capital } from '../src/core/capital.js';
import type { Level } from '../src/cex/venue.js';

const slip = 0.0005; // 0.05%

test('CEX buy size stops exactly at 0.05% average slippage', () => {
  const asks: Level[] = [[100, 1], [100.05, 1], [100.2, 10]];
  const q = maxQuoteWithinSlippage(asks, slip);
  const base = buyWithQuote(asks, q)!;
  assert.ok(Math.abs(q / base - 100 * 1.0005) < 1e-9); // avg price == limit
  assert.ok(q > 200.05 && q < 300); // took both cheap levels + part of the third
});

test('CEX sell size stops at 0.05% average slippage', () => {
  const bids: Level[] = [[100, 1], [99.95, 1], [99.8, 10]];
  const b = maxBaseWithinSlippage(bids, slip);
  assert.ok(Math.abs(walkBids(bids, b)! / b - 100 * 0.9995) < 1e-9);
});

test('whole thin book within slippage → whole book', () => {
  assert.equal(maxQuoteWithinSlippage([[100, 1]], slip), 100);
});

test('DEX impact limit found on the curve', () => {
  // price falls 0.01% per 100 units of input
  const pts = [100, 200, 400, 800, 1600].map((x) => ({ in: x, out: x * (1 - 0.0001 * (x / 100)) }));
  const c = new Curve(pts);
  const x = maxDexInWithinImpact(c, slip);
  const px = (v: number) => c.out(v)! / v;
  assert.ok(Math.abs(px(x) - px(100) * (1 - slip)) < 1e-9);
  assert.ok(x > 500 && x < 700);
});

test('geometric ladder', () => {
  const l = geoLadder(20, 500, 3);
  assert.ok(Math.abs(l[1] - 100) < 1e-9 && l[0] === 20 && Math.abs(l[2] - 500) < 1e-9);
});

test('capital: 2 coins max, 50% each', () => {
  const cycles: any[] = [];
  const store: any = { active: () => cycles };
  const cfg: any = { dryRun: true, quote: 'USDT', strategy: { sizing: { capitalFraction: 0.5, paperCapitalQuote: 1000 } } };
  const cap = new Capital(cfg, new Map([['binance', { id: 'binance', hasKeys: false } as any]]), new Map(), store);
  return cap.refresh(true).then(() => {
    const src = Capital.cexKey('binance');
    assert.equal(cap.capFor(src), 500); // 50% of 1000
    // first cycle started, money not spent yet → still counted as committed
    cycles.push({ direction: 'CEX_TO_DEX', exchange: 'binance', chain: 'arbitrum', step: 'CEX_BUY', sizeQuote: 500 });
    assert.equal(cap.capFor(src), 500); // second coin gets the other half
    cycles.push({ direction: 'CEX_TO_DEX', exchange: 'binance', chain: 'arbitrum', step: 'CEX_BUY', sizeQuote: 500 });
    assert.equal(cap.capFor(src), 0); // nothing left
  });
});
