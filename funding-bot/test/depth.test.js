'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { Trader, maxDepth, vwap } = require('../src/trader');
const { State } = require('../src/state');
const { planWindows, dueWindows } = require('../src/scanner');
const { makeExchange } = require('./helpers');

test('maxDepth: скільки можна взяти, щоб середня ціна не відійшла більше ніж на X%', () => {
  const asks = [[100, 1], [101, 1], [102, 10]];
  // ліміт 101: 1@100 + 1@101 = vwap 100.5; далі з 102 можна ще 1 → vwap рівно 101
  assert.ok(Math.abs(maxDepth(asks, 1, 0.01, 'buy') - 3) < 1e-9);
  assert.ok(Math.abs(vwap(asks, 3) - 101) < 1e-9);
  const bids = [[100, 1], [99, 1], [98, 10]];
  assert.ok(Math.abs(maxDepth(bids, 1, 0.01, 'sell') - 3) < 1e-9);
  // контракти по 0.1 монети
  assert.ok(Math.abs(maxDepth([[100, 10], [101, 10], [102, 100]], 0.1, 0.01, 'buy') - 3) < 1e-9);
  // увесь стакан у межах ліміту — беремо все, що видно
  assert.equal(maxDepth([[100, 5]], 1, 0.01, 'buy'), 5);
  assert.equal(maxDepth([], 1, 0.01, 'buy'), 0);
});

const baseCfg = {
  mode: 'paper', quote: 'USDT', sizeMode: 'auto', maxTradeUsdt: 1000, minTradeUsdt: 20, checkExitDepth: true, coinQty: {}, paused: false,
  positionUsdt: 100, leverage: 3, maxPositions: 3, marginMode: 'isolated', timezone: 'Europe/Kyiv',
  minFunding: 0.001, minProfit: 0, entryBeforeSec: 120, entryMinSec: 20, maxWindowHours: 8, allowEstimated: true,
  maxEntryBasisPct: 0.0015, maxSlippagePct: 0.001, maxAbsFundingRate: 0.1, exitAfterSec: 120, settleDelaySec: 10,
  convergePct: 0.0005, earlyExit: true, liqBufferPct: 0.15, whitelist: [], blacklist: [], defaultTakerFee: 0.0005, coinPriceTol: 0.03,
};
const deep = (p) => ({ bids: [[p * 0.9999, 1e6]], asks: [[p * 1.0001, 1e6]] });

async function setup(cfgOver = {}) {
  const cfg = { ...baseCfg, coinQty: {}, ...cfgOver };
  const T0 = Date.now();
  const a = await makeExchange('a', { rate: 0.03 });
  const b = await makeExchange('b', { rate: 0.01, contractSize: 0.1, step: 1 });
  a.client.next = T0 + 100000;
  b.client.next = T0 + 100000;
  a.client.book = deep(100);
  b.client.book = deep(100);
  const msgs = [];
  const trader = new Trader(cfg, { a, b }, new State(null), async (t) => { msgs.push(t); });
  trader.now = () => T0;
  const rates = { a: await a.fetchFundingRates(), b: await b.fetchFundingRates() };
  const w = dueWindows(planWindows(rates, cfg, undefined, T0), cfg, T0)[0];
  return { cfg, a, b, trader, msgs, w };
}

test('auto: вхід обмежений стаканом біржі шорту', async () => {
  const { a, b, trader, msgs, w } = await setup();
  // на a у бідах лише ~3 ETH близько до найкращої ціни
  a.client.book = { bids: [[99.99, 3], [99, 100]], asks: [[100.01, 1e6]] };
  const cap = await trader.estimateCapacity(w);
  assert.match(cap.limitedBy, /стакан a \(вхід\)/);
  assert.ok(Math.abs(cap.raw - 3.337) < 0.01, String(cap.raw));
  assert.equal(cap.base, 3.3); // спільний крок: a — 0.001 ETH, b — 0.1 ETH
  assert.ok(await trader.tryOpen(w));
  const pos = trader.state.positions[0];
  assert.equal(pos.base, 3.3); // крок біржі b — 1 контракт по 0.1 ETH
  assert.match(msgs[0], /Розмір: 330 USDT/);
  assert.match(msgs[0], /обмежує: стакан a \(вхід\)/);
  assert.ok(a && b);
});

test('auto: ваша сума × плече — позиція 50 USDT маржі × 3 = 150 USDT', async () => {
  const { trader, w, msgs } = await setup({ maxTradeUsdt: 50, leverage: 3 });
  assert.ok(await trader.tryOpen(w));
  assert.equal(trader.state.positions[0].base, 1.5);
  assert.equal(trader.state.positions[0].capacity.limitedBy, 'ваша сума 50×3');
  assert.match(msgs[0], /плече x3 на обох → маржа ~50/);
});

test('auto: враховується стакан на вихід і кількість з /qty', async () => {
  const { b, trader, w, cfg } = await setup();
  b.client.book = { bids: [[99.99, 20], [90, 1e6]], asks: [[100.01, 1e6]] }; // продати лонг на виході можна лише ~2 ETH
  let cap = await trader.estimateCapacity(w);
  assert.match(cap.limitedBy, /стакан b \(вихід\)/);
  assert.ok(Math.abs(cap.base - 2) < 0.05, String(cap.base));
  cfg.checkExitDepth = false;
  cfg.coinQty.ETH = 4;
  cap = await trader.estimateCapacity(w);
  assert.equal(cap.limitedBy, 'ваш максимум ETH');
  assert.equal(cap.base, 4);
});

test('live: вхід обмежений вільною маржею', async () => {
  const { a, trader, w } = await setup({ mode: 'live' });
  a.client.fetchBalance = async () => ({ free: { USDT: 100 } }); // 100 × 3 × 0.85 = 255 USDT
  const cap = await trader.estimateCapacity(w);
  assert.equal(cap.limitedBy, 'баланс a ×3');
  assert.ok(await trader.tryOpen(w));
  assert.equal(trader.state.positions[0].base, 2.5);
});

test('auto: великий обсяг погіршує ціну — зменшуємо, поки профіт ≥ мінімуму', async () => {
  // слипедж не обмежує (5%), але стакан a «тонкий»: кожні 2 ETH ціна падає на 0.5%
  const { a, trader, w, msgs } = await setup({ maxSlippagePct: 0.05, minProfit: 0.015, maxEntryBasisPct: 0.05 });
  a.client.book = { bids: Array.from({ length: 30 }, (_, i) => [100 * (1 - 0.005 * i), 2]), asks: [[100.01, 1e6]] };
  const cap = await trader.estimateCapacity(w);
  assert.match(cap.limitedBy, /прибутковість/);
  const pS = vwap(a.client.book.bids, cap.base);
  const net = 0.02 - 0.002 + Math.min((pS - 100.01) / 100.01, 0);
  assert.ok(net >= 0.015 - 1e-9 && net < 0.0151, String(net));
  assert.ok(await trader.tryOpen(w));
  assert.match(msgs[0], /прибутковість/);
});

test('замало ліквідності — пропуск; фіксована сума більша за стакан — пропуск', async () => {
  let { a, trader, w } = await setup();
  a.client.book = { bids: [[99.99, 0.1], [90, 100]], asks: [[100.01, 1e6]] }; // ~10 USDT
  assert.equal(await trader.tryOpen(w), false);
  ({ a, trader, w } = await setup({ sizeMode: 'usdt', positionUsdt: 1000 }));
  a.client.book = { bids: [[99.99, 3], [90, 100]], asks: [[100.01, 1e6]] };
  assert.equal(await trader.tryOpen(w), false);
  assert.equal(trader.state.positions.length, 0);
});

test('auto: слипедж кожної ноги в нормі, але разом різниця цін завелика — зменшуємо, а не пропускаємо', async () => {
  const { a, b, trader, w } = await setup({ maxEntryBasisPct: 0.0015 });
  a.client.book = { bids: [[99.99, 8], [99.97, 12], [99.9, 30], [99.7, 1e5]], asks: [[100.01, 1e6]] };
  b.client.book = { bids: [[99.99, 1e6]], asks: [[100.01, 150], [100.03, 100], [100.1, 1e5]] };
  assert.ok(await trader.tryOpen(w), 'має зайти на меншу суму');
  const p = trader.state.positions[0];
  assert.ok(p.entryBasis >= -0.0015 - 1e-9, String(p.entryBasis));
  assert.ok(p.base > 5, String(p.base));
});

test('плече: однакове на обох біржах, не більше максимуму біржі', async () => {
  const { a, b, trader, w, msgs } = await setup({ mode: 'live', leverage: 10, maxTradeUsdt: 20 });
  b.client.markets['ETH/USDT:USDT'].limits.leverage = { max: 4 };
  assert.ok(await trader.tryOpen(w));
  assert.equal(a.client.leverage, 4);
  assert.equal(b.client.leverage, 4);
  assert.equal(trader.state.positions[0].leverage, 4);
  assert.equal(trader.state.positions[0].base, 0.8); // 20 USDT × 4 / 100
  assert.match(msgs[0], /плече x4 на обох/);
});

test('плече: біржа не прийняла — не заходимо', async () => {
  const { a, b, trader, w } = await setup({ mode: 'live' });
  b.client.leverageError = 'leverage exceeds limit';
  assert.equal(await trader.tryOpen(w), false);
  assert.equal(a.client.orders.length + b.client.orders.length, 0);
});

test('однакова кількість: спільний крок лотів (0.3 і 0.2 → 0.6)', async () => {
  const { a, b, trader } = await setup({ sizeMode: 'coins', coinQty: { ETH: 1.3 } });
  a.client.markets['ETH/USDT:USDT'].precision.amount = 0.3;
  b.client.markets['ETH/USDT:USDT'].precision.amount = 2; // контракт 0.1 → крок 0.2 ETH
  const S = 'ETH/USDT:USDT';
  assert.equal(trader.pairStep(S, a, b), 0.6);
  trader.cfg.sizeMode = 'auto';
  const z = trader.sizePair(S, a, b, 100, 1.3);
  assert.equal(z.base, 1.2);
  assert.equal(a.contractsToBase(S, z.cS), 1.2);
  assert.equal(b.contractsToBase(S, z.cL), 1.2);
  trader.cfg.sizeMode = 'coins';
  assert.match(trader.sizePair(S, a, b, 100, 1.3).error, /не кратна спільному кроку.*0\.6/);
});

test('часткове виконання на вході — ноги вирівнюються до однакової кількості', async () => {
  const { a, b, trader, w, msgs } = await setup({ mode: 'live', maxTradeUsdt: 1000 });
  b.client.fillRatio = 0.75; // лонг виконався на 75%
  b.client.partialOnce = true;
  assert.ok(await trader.tryOpen(w));
  const p = trader.state.positions[0];
  const sold = a.client.orders[0].amount;
  const bought = Math.floor(b.client.orders[0].amount * 0.75) * 0.1; // біржа виконує цілі контракти
  assert.equal(a.contractsToBase('ETH/USDT:USDT', p.short.contracts), p.base);
  assert.equal(b.contractsToBase('ETH/USDT:USDT', p.long.contracts), p.base);
  assert.ok(Math.abs(p.base - bought) < 1e-9, `${p.base} vs ${bought}`);
  assert.equal(a.client.orders[1].side, 'buy');
  assert.ok(a.client.orders[1].params.reduceOnly);
  assert.ok(Math.abs(a.client.orders[1].amount - (sold - p.base)) < 1e-9);
  assert.match(msgs.find((m) => m.includes('⚖️')), /вирівнюю до/);
});

test('часткове виконання на виході — бот дозакриває залишок, кількість та сама', async () => {
  const { a, b, trader, w } = await setup({ mode: 'live', maxTradeUsdt: 50 });
  assert.ok(await trader.tryOpen(w));
  const base = trader.state.positions[0].base;
  a.client.fillRatio = 0.5;
  a.client.partialOnce = true;
  a.client.partialDone = false;
  const pos = trader.state.positions[0];
  await trader.closePair(pos, 'тест');
  assert.equal(trader.state.positions.length, 0);
  const closes = a.client.orders.slice(1);
  assert.equal(closes.length, 2, 'перший ордер виконано на 50%, другий — залишок');
  assert.ok(Math.abs(closes.reduce((x, o) => x + o.amount * (o === closes[0] ? 0.5 : 1), 0) - base) < 1e-9);
  assert.ok(b);
});
