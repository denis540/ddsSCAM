'use strict';
// Тести на виправлення з фінальної перевірки коду
const test = require('node:test');
const assert = require('node:assert');
const { Trader } = require('../src/trader');
const { State } = require('../src/state');
const { Guard } = require('../src/guard');
const { Reconciler } = require('../src/reconcile');
const { Exchange } = require('../src/exchange');
const { planWindows, dueWindows } = require('../src/scanner');
const { makeExchange, fakeClient } = require('./helpers');

const SYM = 'ETH/USDT:USDT';
const baseCfg = {
  mode: 'live', quote: 'USDT', sizeMode: 'auto', maxTradeUsdt: 50, minTradeUsdt: 5, checkExitDepth: true, paused: false,
  positionUsdt: 100, leverage: 3, maxPositions: 3, marginMode: 'isolated', timezone: 'Europe/Kyiv',
  minFunding: 0.001, minProfit: 0, entryBeforeSec: 120, entryMinSec: 20, maxWindowHours: 8, allowEstimated: true,
  maxEntryBasisPct: 0.0015, maxSlippagePct: 0.001, maxAbsFundingRate: 0.1, exitAfterSec: 120, settleDelaySec: 10,
  convergePct: 0.0005, earlyExit: false, whitelist: [], blacklist: [], defaultTakerFee: 0.0005, coinPriceTol: 0.03,
  orderType: 'auto', liqClosePct: 0.6, liqCheckSec: 5, protectStops: true, stopAtPct: 0.8, maxConvergeWaitMin: 30,
  maxDailyLossUsdt: 0, maxLossStreak: 0, maxErrors: 0, reservePct: 0.2, maxTotalUsdt: 0, maxExchangeUsdt: 0, fundingConfirmSec: 90,
};

async function setup(over = {}) {
  const cfg = { ...baseCfg, coinQty: {}, ...over };
  const T0 = Date.now();
  const a = await makeExchange('a', { rate: 0.03 });
  const b = await makeExchange('b', { rate: 0.01, contractSize: 0.1, step: 1 });
  a.client.next = T0 + 100000;
  b.client.next = T0 + 100000;
  const state = new State(null);
  const msgs = [];
  const trader = new Trader(cfg, { a, b }, state, async (t) => { msgs.push(t); });
  trader.guard = new Guard(cfg, state, null, async () => {});
  trader.positionSyncDelayMs = 0;
  let now = T0;
  trader.now = () => now;
  const at = (ms) => { now = T0 + ms; };
  const rates = async () => ({ a: await a.fetchFundingRates(), b: await b.fetchFundingRates() });
  const window = async () => dueWindows(planWindows(await rates(), cfg, undefined, T0), cfg, T0)[0];
  return { cfg, a, b, state, trader, msgs, at, rates, window };
}

test('біржа відповіла «filled 0», але ордер виконався — бот бере фактичну позицію, а не відкочує ногу', async () => {
  const { a, b, state, trader, window } = await setup();
  const orig = b.client.createOrder.bind(b.client);
  b.client.createOrder = async (...x) => ({ ...(await orig(...x)), filled: 0, status: undefined }); // «ACK»-відповідь
  assert.ok(await trader.tryOpen(await window()));
  const p = state.positions[0];
  assert.equal(b.contractsToBase(SYM, p.long.contracts), p.base, 'лонг узято з позиції на біржі');
  assert.equal(a.client.orders.length, 1, 'жодного відкату шорту');
});

test('скасований ринковий ордер не рахується виконаним', async () => {
  const c = fakeClient();
  c.createOrder = async () => ({ id: '1', filled: 0, status: 'canceled' });
  const ex = new Exchange('x', { apiKey: 'k', secret: 's' }, { client: c });
  await ex.init();
  const o = await ex.marketOrder(SYM, 'buy', 5);
  assert.equal(o.filled, 0);
});

test('на біржі вже є позиція по монеті (ручна) — вхід пропускаємо, бо в one-way позиції змішались би', async () => {
  const { a, trader, window, state } = await setup();
  a.client.pos[SYM] = 0.7;
  assert.equal(await trader.tryOpen(await window()), false);
  assert.equal(state.positions.length, 0);
  assert.equal(a.client.orders.length, 0);
});

test('збій посеред відкриття — намір угоди лишається, звірка закриває непарні ноги', async () => {
  const { a, b, state, trader, window, msgs } = await setup();
  trader.equalizeLegs = async () => { throw new Error('бум'); };
  let crashed = false;
  trader.onCrashDuringOpen = () => { crashed = true; };
  assert.equal(await trader.tryOpen(await window()), false);
  assert.ok(crashed);
  assert.equal(state.data.pending.length, 1, 'намір не стерто');
  assert.match(msgs.at(-1), /збій посеред відкриття/);
  const rec = new Reconciler(trader.cfg, state, trader.ex, trader, async () => {});
  const r = await rec.run();
  assert.equal(r.autoClosed.length, 2);
  assert.equal(a.client.pos[SYM], 0);
  assert.equal(b.client.pos[SYM], 0);
});

test('нога вже закрита біржею під час закриття — без нескінченних повторів і помилки закриття', async () => {
  const { a, state, trader, window, msgs } = await setup();
  assert.ok(await trader.tryOpen(await window()));
  a.client.pos[SYM] = 0; // стоп спрацював
  const orig = a.client.createOrder.bind(a.client);
  a.client.createOrder = async (s, t, side, amt, p, params = {}) => {
    if (params.reduceOnly && !params.stopLossPrice) throw new Error('ReduceOnly Order is rejected');
    return orig(s, t, side, amt, p, params);
  };
  await trader.closePair(state.positions[0], 'тест');
  assert.equal(state.positions.length, 0, 'угоду закрито');
  assert.ok(!state.data.closed[0].closeError);
  assert.match(msgs.find((m) => m.includes('ВИХІД')), /SHORT закрила біржа/);
});

test('біржа частково зменшила ногу (ADL) — хедж порушено, пара закривається', async () => {
  const { b, state, trader, rates, window, at, msgs } = await setup();
  assert.ok(await trader.tryOpen(await window()));
  b.client.pos[SYM] = +(b.client.pos[SYM] * 0.6).toFixed(0);
  at(10000);
  await trader.manage(await rates());
  assert.equal(state.positions.length, 0);
  assert.match(msgs.find((m) => m.includes('ВИХІД')), /розмір ноги змінила біржа/);
  assert.equal(b.client.pos[SYM], 0, 'закрито рівно фактичну кількість');
});

test('ціна ліквідації з біржі «не з того боку» — стоп ставиться за оцінкою, а не одразу біля ціни', async () => {
  const { a, state, trader, window } = await setup();
  a.client.liq = 50; // для шорту ліквідація має бути вище входу — 50 некоректна
  assert.ok(await trader.tryOpen(await window()));
  const pos = state.positions[0];
  assert.ok(pos.short.liq > pos.short.entry);
  assert.ok(a.client.stops[0].params.stopLossPrice > pos.short.entry);
});

test('кількість менша за крок лота: справжній ccxt кидає помилку — бот рахує 0, а не падає', async () => {
  const c = fakeClient();
  c.amountToPrecision = () => { throw new Error('amount must be greater than minimum amount precision'); };
  const ex = new Exchange('x', {}, { client: c });
  await ex.init();
  assert.equal(ex.baseToContracts(SYM, 1e-9), 0);
});

test('«вже налаштовано» розпізнається вузько: справжня помилка зі словом same — не успіх', async () => {
  const c = fakeClient();
  c.has.setMarginMode = false;
  c.setLeverage = async () => { throw new Error('leverage must be the same for all symbols in cross mode'); };
  const ex = new Exchange('x', { apiKey: 'k', secret: 's' }, { client: c });
  await ex.init();
  await assert.rejects(ex.prepareSymbol(SYM, 5, 'isolated'), /не вдалося встановити плече/);
  c.setLeverage = async () => { throw new Error('110043 leverage not modified'); };
  await ex.prepareSymbol(SYM, 6, 'isolated');
});

test('Telegram: не можна змінити чи видалити ключ біржі з відкритими позиціями', async () => {
  const { Telegram } = require('../src/telegram');
  const { Settings } = require('../src/settings');
  const { KeyStore } = require('../src/keys');
  const { a, state, trader, window } = await setup();
  assert.ok(await trader.tryOpen(await window()));
  const tg = new Telegram({ token: 't', chatIds: ['42'] });
  const out = [];
  tg.send = async (t) => { out.push(t); };
  tg.api = async () => ({});
  tg.ctx = { cfg: trader.cfg, settings: new Settings(trader.cfg, null), state, trader, keys: new KeyStore({}, null), all: { a }, exchanges: { a } };
  await tg.handle('/setkey a NEWKEY NEWSECRET', '42', 1);
  assert.match(out.at(-1), /відкриті позиції бота/);
  assert.equal(a.client.apiKey, 'a-key', 'ключ не змінено');
  await tg.handle('/delkey a', '42');
  assert.match(out.at(-1), /відкриті позиції бота/);
});

test('Telegram: ключі в URL помилок бірж не потрапляють у чат', () => {
  const { sanitize } = require('../src/telegram');
  const t = sanitize('htx GET https://api.hbdm.com/v1/x?AccessKeyId=abcd1234efgh5678&Signature=zz 401');
  assert.doesNotMatch(t, /abcd1234/);
  assert.match(t, /api\.hbdm\.com\/v1\/x\?…/);
});
