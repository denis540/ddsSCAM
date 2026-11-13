'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { Trader, vwap } = require('../src/trader');
const { State } = require('../src/state');
const { findOpportunities } = require('../src/scanner');
const { makeExchange } = require('./helpers');

const baseCfg = {
  mode: 'paper', quote: 'USDT', sizeMode: 'usdt', coinQty: {}, paused: false, positionUsdt: 100, leverage: 3, maxPositions: 3, marginMode: 'isolated',
  minSpread8h: 0.0005, minExpectedProfitPct: 0.001, holdHoursEstimate: 24, maxEntryBasisPct: 0.0015,
  maxSlippagePct: 0.001, minMinutesToFunding: 0, maxAbsFundingRate: 0.02, exitSpread8h: 0.0001,
  maxHoldHours: 72, liqBufferPct: 0.15, whitelist: [], blacklist: [], defaultTakerFee: 0.0005,
};
const SYM = 'ETH/USDT:USDT';
const quiet = async () => {};

async function setup(cfgOver = {}, aOpts = {}, bOpts = {}) {
  const cfg = { ...baseCfg, ...cfgOver };
  const a = await makeExchange('a', { rate: 0.001, ...aOpts });
  const b = await makeExchange('b', { rate: -0.0001, contractSize: 0.1, step: 1, ...bOpts });
  const ex = { a, b };
  const state = new State(null, 'Europe/Kyiv');
  const trader = new Trader(cfg, ex, state, quiet);
  const rates = async () => ({ a: await a.fetchFundingRates(), b: await b.fetchFundingRates() });
  return { cfg, a, b, ex, state, trader, rates };
}

test('vwap', () => {
  assert.equal(vwap([[10, 1], [11, 1]], 2), 10.5);
  assert.equal(vwap([[10, 1]], 2), undefined);
  assert.equal(vwap([[10, 20]], 2, 0.1), 10); // 20 контрактів по 0.1 = 2 базових
});

test('paper: відкриття, фандінг, вихід при падінні спреду', async () => {
  const { cfg, a, b, state, trader, rates } = await setup();
  const r = await rates();
  const [opp] = findOpportunities(r, cfg);
  assert.ok(await trader.tryOpen(opp));
  const p = state.positions[0];
  assert.equal(p.shortEx, 'a');
  // 100 USDT / 100 = 1 ETH; на b контракт 0.1 => 10 контрактів
  assert.equal(p.base, 1);
  assert.equal(p.long.contracts, 10);

  // імітуємо настання виплати
  a.client.next = Date.now() - 1; b.client.next = Date.now() - 1;
  p.short.nextTs = Date.now() - 1; p.long.nextTs = Date.now() - 1;
  trader.accrueFunding(r); // фіксуємо lastRate
  assert.ok(p.fundingAccrued > 0);
  const expected = 0.001 * 100 + 0.0001 * 100; // шорт отримав 0.1, лонг отримав 0.01
  assert.ok(Math.abs(p.fundingAccrued - expected) < 1e-6, String(p.fundingAccrued));

  // спред зник -> закриття
  a.client.rate = 0.0001; b.client.rate = 0.0001;
  await trader.manage(await rates());
  assert.equal(state.positions.length, 0);
  const closed = state.data.closed[0];
  // фандінг 0.11 - комісії 4*0.05%*100=0.2 - спред стакану 0.04 = -0.13 (одна виплата комісій не покриває)
  assert.ok(Math.abs(closed.pnl - (expected - 0.2 - 0.04)) < 1e-6, String(closed.pnl));
});

test('не відкриває вдруге той самий символ і поважає maxPositions', async () => {
  const { cfg, trader, state, rates } = await setup();
  const [opp] = findOpportunities(await rates(), cfg);
  assert.ok(await trader.tryOpen(opp));
  assert.equal(await trader.tryOpen(opp), false);
  assert.equal(state.positions.length, 1);
});

test('live: якщо одна нога впала — інша відкочується reduceOnly', async () => {
  const { cfg, a, b, trader, state, rates } = await setup({ mode: 'live' });
  b.client.fail = true;
  const [opp] = findOpportunities(await rates(), cfg);
  assert.equal(await trader.tryOpen(opp), false);
  assert.equal(state.positions.length, 0);
  assert.equal(a.client.orders.length, 2);
  assert.equal(a.client.orders[0].side, 'sell');
  assert.equal(a.client.orders[1].side, 'buy');
  assert.equal(a.client.orders[1].params.reduceOnly, true);
});

test('live: відкриття і закриття ставить правильні ордери', async () => {
  const { cfg, a, b, trader, state, rates } = await setup({ mode: 'live', maxHoldHours: 0 });
  const [opp] = findOpportunities(await rates(), cfg);
  assert.ok(await trader.tryOpen(opp));
  assert.deepEqual(a.client.orders.map((o) => o.side), ['sell']);
  assert.deepEqual(b.client.orders.map((o) => [o.side, o.amount]), [['buy', 10]]);
  // fetchPositions порожній -> трактуємо як зниклу позицію, але maxHoldHours=0 спрацює раніше
  await trader.manage(await rates());
  assert.equal(state.positions.length, 0);
  assert.equal(a.client.orders[1].side, 'buy');
  assert.equal(b.client.orders[1].side, 'sell');
  assert.ok(b.client.orders[1].params.reduceOnly);
});

test('режим монет: вхід і вихід рівно заданою кількістю', async () => {
  const { cfg, a, b, trader, state, rates } = await setup({ mode: 'live', sizeMode: 'coins', coinQty: { ETH: 2.5 }, maxHoldHours: 0 });
  const [opp] = findOpportunities(await rates(), cfg);
  assert.ok(await trader.tryOpen(opp));
  assert.equal(state.positions[0].base, 2.5);
  assert.deepEqual(a.client.orders.map((o) => o.amount), [2.5]);   // contractSize 1
  assert.deepEqual(b.client.orders.map((o) => o.amount), [25]);    // contractSize 0.1 => 25 контрактів
  await trader.manage(await rates());
  assert.deepEqual(a.client.orders.map((o) => o.amount), [2.5, 2.5]);
  assert.deepEqual(b.client.orders.map((o) => o.amount), [25, 25]);
  assert.equal(state.data.daily[state.dayKey()].closed, 1);
});

test('режим монет: пропуск, якщо кількість не задана або не кратна лоту', async () => {
  const { cfg, trader, state, rates } = await setup({ sizeMode: 'coins', coinQty: {} });
  const [opp] = findOpportunities(await rates(), cfg);
  assert.equal(await trader.tryOpen(opp), false);
  cfg.coinQty.ETH = 2.55; // на біржі b крок 0.1 ETH => 2.5, округлення > 1%
  assert.equal(await trader.tryOpen(opp), false);
  cfg.coinQty.ETH = 2.6;
  assert.ok(await trader.tryOpen(opp));
  assert.equal(state.positions[0].base, 2.6);
});

test('пауза і maxPositions = 0 блокують вхід', async () => {
  const { cfg, trader, rates } = await setup({ paused: true });
  const [opp] = findOpportunities(await rates(), cfg);
  assert.equal(await trader.tryOpen(opp), false);
  cfg.paused = false; cfg.maxPositions = 0;
  assert.equal(await trader.tryOpen(opp), false);
});

test('сповіщення містять ордери і PnL', async () => {
  const msgs = [];
  const { cfg, trader, rates } = await setup({ maxHoldHours: 0 });
  trader.notify = async (t) => { msgs.push(t); };
  const [opp] = findOpportunities(await rates(), cfg);
  await trader.tryOpen(opp);
  await trader.manage(await rates());
  assert.match(msgs[0], /ВІДКРИТО ETH/);
  assert.match(msgs[0], /SELL 1 ETH @ 99\.99 на a/);
  assert.match(msgs[0], /BUY 1 ETH \(10 контр\.\) @ 100\.01 на b/);
  assert.match(msgs[1], /ЗАКРИТО/);
  assert.match(msgs[1], /PnL угоди: -0\.24/);
  assert.match(msgs[1], /Загальний PnL: -0\.24/);
});
