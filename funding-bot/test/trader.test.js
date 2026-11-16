'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { Trader, vwap } = require('../src/trader');
const { State } = require('../src/state');
const { planWindows, dueWindows } = require('../src/scanner');
const { makeExchange } = require('./helpers');

const SYM = 'ETH/USDT:USDT';
const baseCfg = {
  mode: 'paper', quote: 'USDT', sizeMode: 'usdt', coinQty: {}, paused: false, positionUsdt: 100, leverage: 3,
  maxPositions: 3, marginMode: 'isolated', timezone: 'Europe/Kyiv',
  minFunding: 0.001, minProfit: 0, entryBeforeSec: 120, entryMinSec: 20, maxWindowHours: 8, lookaheadHours: 8,
  allowEstimated: true, maxEntryBasisPct: 0.0015, maxSlippagePct: 0.001, maxAbsFundingRate: 0.1,
  exitAfterSec: 120, settleDelaySec: 10, convergePct: 0.0005, earlyExit: true, liqBufferPct: 0.15,
  whitelist: [], blacklist: [], defaultTakerFee: 0.0005,
};

/** a = "OKX" (ставка 3%), b = "Binance" (1%, контракт 0.1). Виплата на обох через 100 с. */
async function setup(cfgOver = {}, aOpts = {}, bOpts = {}) {
  const cfg = { ...baseCfg, ...cfgOver };
  const T0 = Date.now();
  const a = await makeExchange('a', { rate: 0.03, ...aOpts });
  const b = await makeExchange('b', { rate: 0.01, contractSize: 0.1, step: 1, ...bOpts });
  a.client.next = aOpts.next ?? T0 + 100000;
  b.client.next = bOpts.next ?? T0 + 100000;
  const state = new State(null, 'Europe/Kyiv');
  const msgs = [];
  const trader = new Trader(cfg, { a, b }, state, async (t) => { msgs.push(t); });
  let now = T0;
  trader.now = () => now;
  const at = (ms) => { now = T0 + ms; };
  const rates = async () => ({ a: await a.fetchFundingRates(), b: await b.fetchFundingRates() });
  const window = async () => dueWindows(planWindows(await rates(), cfg, undefined, T0), cfg, T0)[0];
  return { cfg, a, b, state, trader, rates, window, at, msgs, T0 };
}

test('vwap', () => {
  assert.equal(vwap([[10, 1], [11, 1]], 2), 10.5);
  assert.equal(vwap([[10, 1]], 2), undefined);
  assert.equal(vwap([[10, 20]], 2, 0.1), 10); // 20 контрактів по 0.1 = 2 базових
});

test('повний цикл: вхід за 2 хв, виплата, вихід одразу як ціни зійшлися', async () => {
  const { a, state, trader, rates, window, at, msgs } = await setup();
  const w = await window();
  assert.ok(w, 'вікно має бути «due» за 100 с до виплати');
  assert.equal(w.shortEx, 'a');
  assert.ok(await trader.tryOpen(w));
  const pos = state.positions[0];
  assert.equal(pos.base, 1);
  assert.equal(pos.events.length, 2);

  // до виплати ціни розійшлися (немає раннього виходу)
  a.client.price = 100.5;
  at(60000);
  await trader.manage(await rates());
  assert.equal(state.positions.length, 1);

  // виплата пройшла (+10 с затримки), ціни ще не зійшлися — тримаємо
  at(111000);
  await trader.manage(await rates());
  assert.equal(state.positions.length, 1);
  assert.ok(Math.abs(pos.fundingAccrued - (0.03 * 100.5 - 0.01 * 100)) < 1e-9, String(pos.fundingAccrued));

  // ціни зійшлися — вихід, не чекаючи 2 хв
  a.client.price = 100;
  at(130000);
  await trader.manage(await rates());
  assert.equal(state.positions.length, 0);
  assert.match(msgs.at(-1), /ціни зійшлися/);
  const c = state.data.closed[0];
  // фандінг 2.015 − комісії 0.2 − спред стакану 0.04
  assert.ok(Math.abs(c.pnl - (2.015 - 0.2 - 0.04)) < 1e-6, String(c.pnl));
});

test('ціни не зійшлися — вихід через exitAfterSec після виплати', async () => {
  const { a, state, trader, rates, window, at, msgs } = await setup();
  assert.ok(await trader.tryOpen(await window()));
  a.client.price = 101;
  at(150000);
  await trader.manage(await rates());
  assert.equal(state.positions.length, 1);
  at(100000 + 121000);
  await trader.manage(await rates());
  assert.equal(state.positions.length, 0);
  assert.match(msgs.at(-1), /після виплати/);
});

test('вихід через 5 с після виплати: ціни не зійшлися, але угода в плюсі — фіксує одразу', async () => {
  const { a, state, trader, rates, window, at, msgs } = await setup({ exitAfterSec: 5, settleDelaySec: 5, maxConvergeWaitMin: 30 });
  assert.ok(await trader.tryOpen(await window()));
  a.client.price = 100.3; // різниця цін не зійшлася, але фандінг 2% її покриває
  at(100000 + 4000);
  await trader.manage(await rates());
  assert.equal(state.positions.length, 1, 'раніше 5 с після виплати не закривається');
  at(100000 + 6000);
  await trader.manage(await rates());
  assert.equal(state.positions.length, 0);
  assert.match(msgs.at(-1), /угода в плюсі/);
  assert.ok(state.data.closed[0].pnl > 0);
});

test('BASIS_COST=false: заходить попри несприятливу різницю цін (у межах допуску), виходить, коли разом у плюсі', async () => {
  const over = { maxEntryBasisPct: 0.005, minProfit: 0.0175, exitAfterSec: 5, settleDelaySec: 5, maxConvergeWaitMin: 30 };
  {
    const { a, trader, window } = await setup(over);
    a.client.price = 99.7; // на біржі шорту ціна нижча на ~0.3%
    const w = await window();
    assert.ok(!w || !(await trader.tryOpen(w)), 'за замовчуванням різниця цін — витрата: 2% − 0.2% − 0.3% < 1.75%');
  }
  const { a, state, trader, window, rates, at, msgs } = await setup({ ...over, basisCost: false });
  a.client.price = 99.7;
  assert.ok(await trader.tryOpen(await window()));
  const pos = state.positions[0];
  assert.ok(pos.entryBasis < -0.002, String(pos.entryBasis));
  at(100000 + 6000); // різниця цін та сама, що на вході — фандінг у кишені
  await trader.manage(await rates());
  assert.equal(state.positions.length, 0);
  assert.match(msgs.at(-1), /на вході була/);
  assert.ok(state.data.closed[0].pnl > 0);
});

test('різний час: виплата лише OKX через 100 с, Binance через 1 год — вихід після OKX', async () => {
  const { T0, state, trader, rates, window, at } = await setup({}, {}, { next: Date.now() + 3600000 });
  const w = await window();
  assert.deepEqual(w.events.map((e) => e.ex), ['a']);
  assert.ok(await trader.tryOpen(w));
  at(115000);
  await trader.manage(await rates());
  assert.equal(state.positions.length, 0, 'ціни рівні — вихід одразу після виплати OKX');
  assert.ok(Math.abs(state.data.closed[0].fundingAccrued - 0.03 * 100) < 1e-9);
  assert.ok(T0);
});

test('ставка розвернулась до виплати — вихід', async () => {
  const { a, state, trader, rates, window, at, msgs } = await setup();
  assert.ok(await trader.tryOpen(await window()));
  a.client.rate = -0.01;
  at(50000);
  await trader.manage(await rates());
  assert.equal(state.positions.length, 0);
  assert.match(msgs.at(-1), /ставка змінилась/);
});

test('ранній вихід: ціни зійшлися до виплати і прибуток від цін уже більший за фандінг', async () => {
  const { cfg, a, state, trader, rates, window, at, msgs } = await setup();
  assert.ok(await trader.tryOpen(await window()));
  // До виплати ціна на біржі шорту впала на 3%: різниця цін дає ~+2.86, а фандінг очікується ~+2
  a.client.price = 97;
  at(40000);
  cfg.earlyExit = false;
  await trader.manage(await rates());
  assert.equal(state.positions.length, 1, 'з earlyexit=off чекаємо виплату');
  cfg.earlyExit = true;
  await trader.manage(await rates());
  assert.equal(state.positions.length, 0);
  assert.match(msgs.at(-1), /ДО виплати/);
  assert.ok(state.data.closed[0].pnl > 2.5);
});

test('свіжа ставка перед входом впала нижче порогу — пропуск', async () => {
  const { a, trader, window, state } = await setup();
  const w = await window();
  a.client.rate = 0.0101; // фандінг 0.01% < 0.1%
  assert.equal(await trader.tryOpen(w), false);
  assert.equal(state.positions.length, 0);
});

test('не відкриває вдруге той самий символ, поважає maxPositions і паузу', async () => {
  const { cfg, trader, state, window } = await setup();
  const w = await window();
  cfg.paused = true;
  assert.equal(await trader.tryOpen(w), false);
  cfg.paused = false;
  assert.ok(await trader.tryOpen(w));
  assert.equal(await trader.tryOpen(w), false);
  assert.equal(state.positions.length, 1);
});

test('live: якщо одна нога впала — інша відкочується reduceOnly', async () => {
  const { a, b, trader, state, window } = await setup({ mode: 'live' });
  b.client.fail = true;
  assert.equal(await trader.tryOpen(await window()), false);
  assert.equal(state.positions.length, 0);
  assert.deepEqual(a.client.orders.map((o) => [o.side, !!o.params.reduceOnly]), [['sell', false], ['buy', true]]);
});

test('live, режим монет: вхід і вихід рівно заданою кількістю, фандінг з історії біржі', async () => {
  const { a, b, trader, state, rates, window, at, msgs } = await setup({ mode: 'live', sizeMode: 'coins', coinQty: { ETH: 2.5 } });
  assert.ok(await trader.tryOpen(await window()));
  assert.equal(state.positions[0].base, 2.5);
  assert.deepEqual(a.client.orders.map((o) => o.amount), [2.5]);
  assert.deepEqual(b.client.orders.map((o) => o.amount), [25]); // контракт 0.1
  const T = Date.now();
  a.client.funding = [{ symbol: SYM, timestamp: T + 100000, amount: 7.4 }];
  b.client.funding = [{ symbol: SYM, timestamp: T + 100000, amount: -2.5 }];
  at(115000);
  await trader.manage(await rates());
  assert.equal(state.positions.length, 0);
  assert.deepEqual(a.client.orders.map((o) => [o.side, o.amount]), [['sell', 2.5], ['buy', 2.5]]);
  assert.deepEqual(b.client.orders.map((o) => [o.side, o.amount]), [['buy', 25], ['sell', 25]]);
  assert.ok(Math.abs(state.data.closed[0].fundingAccrued - 4.9) < 1e-9);
  assert.match(msgs.at(-1), /факт з бірж/);
});

test('режим монет: пропуск, якщо кількість не задана або не кратна лоту', async () => {
  const { cfg, trader, window, state } = await setup({ sizeMode: 'coins', coinQty: {} });
  const w = await window();
  assert.equal(await trader.tryOpen(w), false);
  trader.skipped.clear();
  cfg.coinQty.ETH = 2.55; // на біржі b крок 0.1 ETH
  assert.equal(await trader.tryOpen(w), false);
  trader.skipped.clear();
  cfg.coinQty.ETH = 2.6;
  assert.ok(await trader.tryOpen(w));
  assert.equal(state.positions[0].base, 2.6);
});

test('сповіщення: ордери, виплати, PnL угоди і загальний', async () => {
  const { trader, rates, window, at, msgs } = await setup();
  await trader.tryOpen(await window());
  at(115000);
  await trader.manage(await rates());
  assert.match(msgs[0], /ВХІД ETH/);
  assert.match(msgs[0], /SELL 1 ETH @ 99\.99 на a/);
  assert.match(msgs[0], /BUY 1 ETH \(10 контр\.\) @ 100\.01 на b/);
  assert.match(msgs[0], /a SHORT: ✅ отримуємо .*ставка 3\.0000%/);
  assert.match(msgs[0], /План виходу: позиція ВІДКРИТА/);
  assert.match(msgs[0], /Очікуваний фандінг: \+2%/);
  assert.match(msgs[1], /ВИХІД/);
  assert.match(msgs[1], /Отримані виплати/);
  assert.match(msgs[1], /PnL угоди: \+1\.76/);
  assert.match(msgs[1], /Загальний PnL: \+1\.76/);
});

test('live: біржа без API-ключа — не торгуємо (лише дані)', async () => {
  const { b, trader, window, state } = await setup({ mode: 'live' });
  const w = await window();
  b.setCredentials({});
  assert.equal(await trader.tryOpen(w), false);
  assert.equal(state.positions.length, 0);
  assert.equal(b.client.orders.length, 0);
});

test('ризик ліквідації перевіряється кожні 5 с на обох біржах одночасно', async () => {
  const { a, b, state, trader, rates, window, at, msgs } = await setup({ mode: 'live', leverage: 3, liqCheckSec: 5, liqClosePct: 0.6 });
  assert.ok(await trader.tryOpen(await window()));
  const calls = [];
  for (const [c, name] of [[a.client, 'a'], [b.client, 'b']]) {
    const orig = c.fetchPositions.bind(c);
    c.fetchPositions = async (...x) => { calls.push(name); return orig(...x); };
  }
  a.client.price = 101; // щоб не спрацював вихід через сходження цін
  b.client.liq = 70;
  b.client.mark = 95; // лонг: вхід ~100, ліквідація 70 → пройдено ~17% шляху
  at(10000);
  await trader.manage(await rates());
  at(15000);
  await trader.manage(await rates());
  assert.deepEqual(calls, ['a', 'b', 'a', 'b'], 'дві перевірки за 5 с, кожна — обидві біржі');
  assert.equal(state.positions.length, 1);
  b.client.mark = 81; // пройдено ~63% шляху до ліквідації (ліміт 60%)
  at(20000);
  await trader.manage(await rates());
  assert.equal(state.positions.length, 0);
  assert.match(msgs.at(-1), /LONG b: ціна пройшла 63% шляху до ліквідації/);
  assert.ok(b.client.orders.at(-1).params.reduceOnly);
  assert.equal(b.client.orders.at(-1).type, 'market', 'термінове закриття — ринком');
});
