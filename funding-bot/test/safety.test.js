'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { Trader } = require('../src/trader');
const { State } = require('../src/state');
const { Guard } = require('../src/guard');
const { Reconciler } = require('../src/reconcile');
const { Exchange } = require('../src/exchange');
const { planWindows, dueWindows } = require('../src/scanner');
const { setClockOffset, nowSynced } = require('../src/time');
const { makeExchange, fakeClient } = require('./helpers');

const SYM = 'ETH/USDT:USDT';
const baseCfg = {
  mode: 'live', quote: 'USDT', sizeMode: 'auto', maxTradeUsdt: 50, minTradeUsdt: 5, checkExitDepth: true, paused: false,
  positionUsdt: 100, leverage: 3, maxPositions: 3, marginMode: 'isolated', timezone: 'Europe/Kyiv',
  minFunding: 0.001, minProfit: 0, entryBeforeSec: 120, entryMinSec: 20, maxWindowHours: 8, allowEstimated: true,
  maxEntryBasisPct: 0.0015, maxSlippagePct: 0.001, maxAbsFundingRate: 0.1, exitAfterSec: 120, settleDelaySec: 10,
  convergePct: 0.0005, earlyExit: false, whitelist: [], blacklist: [], defaultTakerFee: 0.0005, coinPriceTol: 0.03,
  orderType: 'auto', liqClosePct: 0.6, liqCheckSec: 5, protectStops: true, stopAtPct: 0.8, maxConvergeWaitMin: 30,
  maxDailyLossUsdt: 20, maxLossStreak: 3, maxErrors: 5, reservePct: 0.2, maxTotalUsdt: 0, maxExchangeUsdt: 0,
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
  const notify = async (t) => { msgs.push(t); };
  const trader = new Trader(cfg, { a, b }, state, notify);
  const guard = new Guard(cfg, state, null, notify);
  trader.guard = guard;
  let now = T0;
  trader.now = () => now;
  const at = (ms) => { now = T0 + ms; };
  const rates = async () => ({ a: await a.fetchFundingRates(), b: await b.fetchFundingRates() });
  const window = async () => dueWindows(planWindows(await rates(), cfg, undefined, T0), cfg, T0)[0];
  return { cfg, a, b, state, trader, guard, msgs, at, rates, window, T0 };
}

// ---------- 1. Захисні стопи на біржах ----------

test('стопи на біржах ставляться після входу (80% шляху до ліквідації) і знімаються після виходу', async () => {
  const { a, b, state, trader, rates, window, at, msgs } = await setup();
  a.client.liq = 133.33;
  b.client.liq = 66.67;
  assert.ok(await trader.tryOpen(await window()));
  const pos = state.positions[0];
  assert.equal(a.client.stops.length, 1);
  assert.equal(b.client.stops.length, 1);
  const sa = a.client.stops[0];
  const sb = b.client.stops[0];
  assert.equal(sa.side, 'buy');
  assert.equal(sb.side, 'sell');
  assert.ok(sa.params.reduceOnly && sb.params.reduceOnly);
  // шорт: вхід 99.99 → ліквідація 133.33 → стоп на 80% шляху ≈ 126.66
  assert.ok(Math.abs(sa.params.stopLossPrice - (pos.short.entry + (133.33 - pos.short.entry) * 0.8)) < 1e-6, String(sa.params.stopLossPrice));
  assert.ok(sb.params.stopLossPrice < pos.long.entry && sb.params.stopLossPrice > 66.67);
  assert.match(msgs.join('\n'), /захисні стопи на біржах/);
  a.client.funding = [{ symbol: SYM, timestamp: Date.now() + 100000, amount: 0.75 }];
  b.client.funding = [{ symbol: SYM, timestamp: Date.now() + 100000, amount: -0.25 }];
  at(115000);
  await trader.manage(await rates());
  assert.equal(state.positions.length, 0);
  assert.equal(a.client.stops[0].active, false, 'стоп скасовано після виходу');
  assert.equal(b.client.stops[0].active, false);
});

test('біржа не прийняла стоп — попередження, позиція лишається під захистом бота', async () => {
  const { a, state, trader, window, msgs, guard } = await setup();
  a.client.stopFail = true;
  assert.ok(await trader.tryOpen(await window()));
  assert.equal(state.positions.length, 1);
  assert.match(msgs.join('\n'), /стоп не поставлено/);
  assert.equal(guard.errors.length, 1);
});

test('спрацював стоп / ліквідація на одній біржі — бот одразу закриває другу ногу ринком', async () => {
  const { a, b, state, trader, rates, window, at, msgs } = await setup();
  assert.ok(await trader.tryOpen(await window()));
  a.client.pos[SYM] = 0; // біржа a закрила шорт (стоп)
  at(10000);
  await trader.manage(await rates());
  assert.equal(state.positions.length, 1, 'одна порожня відповідь API — ще не привід закривати');
  at(15000);
  await trader.manage(await rates());
  assert.equal(state.positions.length, 0);
  const last = b.client.orders.at(-1);
  assert.equal(last.side, 'sell');
  assert.equal(last.type, 'market');
  assert.ok(last.params.reduceOnly);
  const exit = msgs.find((m) => m.includes('ВИХІД'));
  assert.match(exit, /зникла/);
  assert.match(exit, /SHORT закрила біржа, ціна 100\.01 \(оцінка за стаканом\)/);
  assert.ok(Math.abs(state.data.closed[0].pricePnl) < 0.1, 'без фантомного збитку');
  // з історією угод біржі — фактична ціна
  const s2 = await setup();
  assert.ok(await s2.trader.tryOpen(await s2.window()));
  s2.a.client.pos[SYM] = 0;
  s2.a.client.has.fetchMyTrades = true;
  s2.a.client.fetchMyTrades = async () => [{ side: 'buy', price: 104, amount: 0.5, timestamp: Date.now() + 5000 }];
  s2.at(10000);
  await s2.trader.manage(await s2.rates());
  s2.at(15000);
  await s2.trader.manage(await s2.rates());
  assert.match(s2.msgs.find((m) => m.includes('ВИХІД')), /ціна 104 \(факт з біржі\)/);
});

// ---------- 2. Звірка з біржами ----------

test('звірка: непарна нога після збою посеред відкриття закривається автоматично', async () => {
  const { a, state, trader, msgs } = await setup();
  state.setPending({ symbol: SYM, shortEx: 'a', longEx: 'b', ts: Date.now() - 60000 });
  a.client.pos[SYM] = -0.5; // шорт відкрився, бот впав до лонгу
  const rec = new Reconciler(trader.cfg, state, trader.ex, trader, async (t) => { msgs.push(t); });
  const r = await rec.run();
  assert.equal(r.autoClosed.length, 1);
  assert.equal(a.client.pos[SYM], 0);
  assert.equal(a.client.orders.at(-1).type, 'market');
  assert.match(msgs.at(-1), /непарну ногу .* закрито/);
});

test('звірка: невідома позиція — попередження з кнопкою, закриття кнопкою; збіг — тиша', async () => {
  const { a, b, state, trader, window } = await setup();
  assert.ok(await trader.tryOpen(await window()));
  const sent = [];
  const rec = new Reconciler(trader.cfg, state, trader.ex, trader, async (t, m) => { sent.push({ t, m }); });
  let r = await rec.run();
  assert.equal(r.orphans.length + r.mismatches.length, 0, 'позиції бота збігаються з біржами');
  b.client.pos['BTC/USDT:USDT'] = 3; // чужа позиція
  b.client.markets['BTC/USDT:USDT'] = { ...b.client.markets[SYM], symbol: 'BTC/USDT:USDT', base: 'BTC' };
  b.buildSymbolMap();
  r = await rec.run();
  assert.equal(r.orphans.length, 1);
  const btn = sent.at(-1).m.inline_keyboard[0][0];
  assert.match(btn.callback_data, /^orph:/);
  await rec.run();
  assert.equal(sent.filter((x) => x.m).length, 1, 'про ту саму позицію не повторюємо');
  const res = await rec.closeOrphan(btn.callback_data.split(':')[1]);
  assert.match(res, /Закрито/);
  assert.equal(b.client.pos['BTC/USDT:USDT'], 0);
  // розбіжність кількості
  a.client.pos[SYM] -= 0.1;
  r = await rec.run();
  assert.equal(r.mismatches.length, 1);
});

// ---------- 3. Тип ордерів: бот обирає сам ----------

test('вхід лімітними IOC з межею ціни; стакан змінився і лімітка не виконалась — без збитку', async () => {
  const { a, b, state, trader, window, msgs } = await setup();
  assert.ok(await trader.tryOpen(await window()));
  const oa = a.client.orders[0];
  const ob = b.client.orders[0];
  assert.equal(oa.type, 'limit');
  assert.equal(oa.params.timeInForce, 'IOC');
  assert.equal(ob.type, 'limit');
  assert.match(msgs[0], /\[ліміт IOC\]/);
  assert.equal(state.positions.length, 1);

  const s2 = await setup();
  s2.b.client.limitFill = 0; // лімітка лонгу не виконалась (стакан пішов)
  assert.equal(await s2.trader.tryOpen(await s2.window()), false);
  assert.equal(s2.a.client.pos[SYM], 0, 'шорт закрито, ноги не лишилось');
  assert.equal(s2.a.client.orders.at(-1).type, 'market', 'термінове закриття — ринком');
  assert.match(s2.msgs.join('\n'), /вхід скасовано/);
});

test('біржа не приймає IOC — бот перемикається на ринкові для неї', async () => {
  const { a, state, trader, window, msgs } = await setup();
  a.client.iocError = 'timeInForce IOC not supported';
  assert.ok(await trader.tryOpen(await window()));
  assert.ok(a.iocUnsupported);
  assert.equal(a.client.orders[0].type, 'market');
  assert.match(msgs[0], /на a .*\[ринок\]/);
  assert.equal(state.positions.length, 1);
});

test('ORDER_TYPE=market — лише ринкові', async () => {
  const { a, b, trader, window } = await setup({ orderType: 'market' });
  assert.ok(await trader.tryOpen(await window()));
  assert.equal(a.client.orders[0].type, 'market');
  assert.equal(b.client.orders[0].type, 'market');
});

test('вихід: лімітка не виконалась двічі — бот закриває ринком (вихід гарантовано)', async () => {
  const s = await setup();
  assert.ok(await s.trader.tryOpen(await s.window()));
  s.a.client.limitFill = 0; // лімітки на a не виконуються
  const pos = s.state.positions[0];
  await s.trader.closePair(pos, 'тест');
  const closes = s.a.client.orders.slice(1);
  assert.deepEqual(closes.map((o) => o.type), ['limit', 'limit', 'market']);
  assert.equal(s.a.client.pos[SYM], 0);
  assert.equal(s.state.positions.length, 0);
});

// ---------- 4. Режим позицій ----------

test('hedge mode: бот перемикає на one-way; якщо не вдається — торгівлю на біржі блокує', async () => {
  const c = fakeClient();
  c.has.fetchPositionMode = true;
  c.has.setPositionMode = true;
  let hedged = true;
  c.fetchPositionMode = async () => ({ hedged });
  c.setPositionMode = async (h) => { hedged = h; };
  const ex = new Exchange('x', { apiKey: 'k', secret: 's' }, { client: c });
  assert.equal(await ex.ensureOneWay(), undefined);
  assert.equal(hedged, false);
  hedged = true;
  c.setPositionMode = async () => { throw new Error('position exists'); };
  assert.match(await ex.ensureOneWay(), /не вдалося .* one-way/);
  const { a, trader, window } = await setup();
  a.tradeBlocked = 'hedge mode';
  assert.equal(await trader.tryOpen(await window()), false);
});

// ---------- 5. Аварійні запобіжники ----------

test('запобіжники: збиток за день, збиткові поспіль, помилки — автопауза; /resume знімає', async () => {
  const { cfg, state, guard, msgs } = await setup();
  state.addDaily('pnl', -25);
  await guard.onTradeClosed(-25);
  assert.ok(cfg.paused);
  assert.match(cfg.pauseReason, /збиток за сьогодні -25/);
  assert.match(msgs.at(-1), /АВТОПАУЗА/);
  guard.resume();
  cfg.paused = false;

  const s2 = await setup();
  for (let i = 0; i < 3; i++) await s2.guard.onTradeClosed(-0.1);
  assert.match(s2.cfg.pauseReason, /3 збиткових угод поспіль/);

  const s3 = await setup();
  await s3.guard.onTradeClosed(-0.1);
  await s3.guard.onTradeClosed(+1);
  await s3.guard.onTradeClosed(-0.1);
  assert.ok(!s3.cfg.paused, 'прибуткова угода обнуляє серію');
  for (let i = 0; i < 5; i++) await s3.guard.onError('x');
  assert.match(s3.cfg.pauseReason, /5 помилок ордерів/);
});

test('на автопаузі нові позиції не відкриваються', async () => {
  const { cfg, trader, window, guard } = await setup();
  await guard.trip('тест');
  assert.equal(await trader.tryOpen(await window()), false);
  assert.ok(cfg.paused);
});

// ---------- 6. Очікування сходження цін ----------

test('після виплати ціни не зійшлися і вихід у мінус — чекаємо; зійшлись — виходимо', async () => {
  const { a, state, trader, rates, window, at, msgs } = await setup();
  assert.ok(await trader.tryOpen(await window()));
  a.client.price = 103; // шорт у мінусі на 3% > фандінгу 2%
  at(100000 + 125000); // минуло exitAfter
  await trader.manage(await rates());
  assert.equal(state.positions.length, 1, 'не продаємо в мінус');
  assert.match(msgs.at(-1), /чекаю сходження до/);
  at(100000 + 300000);
  await trader.manage(await rates());
  assert.equal(state.positions.length, 1);
  assert.equal(msgs.filter((m) => m.includes('чекаю сходження')).length, 1, 'повідомлення один раз');
  a.client.price = 100;
  at(100000 + 400000);
  await trader.manage(await rates());
  assert.equal(state.positions.length, 0);
  assert.match(msgs.at(-1), /ціни зійшлися/);
});

test('чекання не довше maxwait і не до наступної виплати', async () => {
  const { a, state, trader, rates, window, at, msgs } = await setup({ maxConvergeWaitMin: 30 });
  assert.ok(await trader.tryOpen(await window()));
  a.client.price = 103;
  a.client.next = Date.now() + 100000 + 10 * 60000; // наступна виплата на a через 10 хв після нашої
  at(100000 + 125000);
  await trader.manage(await rates());
  assert.equal(state.positions.length, 1);
  at(100000 + 9 * 60000 + 1000); // за хвилину до наступної виплати — виходимо
  await trader.manage(await rates());
  assert.equal(state.positions.length, 0);
  assert.match(msgs.at(-1), /ціни так і не зійшлися/);
});

// ---------- 7. Небезпечні монети ----------

test('ризики ринку: нова монета, делістинг, статус', () => {
  const now = Date.now();
  const c = fakeClient();
  const ex = new Exchange('x', {}, { client: c });
  ex.native[SYM] = SYM;
  const m = c.markets[SYM];
  assert.equal(ex.marketRisk(SYM, {}, now), undefined);
  m.created = now - 3600000;
  assert.match(ex.marketRisk(SYM, { newListingDays: 3 }, now), /нова монета/);
  m.created = now - 30 * 86400000;
  m.info = { deliveryDate: String(now + 5 * 86400000) };
  assert.match(ex.marketRisk(SYM, { delistDays: 14 }, now), /делістинг.*через 5 дн/);
  m.info = { deliveryDate: '4133404800000' }; // Binance: «безстроковий» перпетуал
  assert.equal(ex.marketRisk(SYM, {}, now), undefined);
  m.info = { status: 'SETTLING' };
  assert.match(ex.marketRisk(SYM, {}, now), /статус/);
  m.info = { status: 'TRADING' };
  assert.equal(ex.marketRisk(SYM, {}, now), undefined);
});

// ---------- 8. Годинник ----------

test('поправка годинника: бот рахує таймінги за часом біржі', async () => {
  const c = fakeClient();
  c.has.fetchTime = true;
  c.fetchTime = async () => Date.now() + 2500;
  const ex = new Exchange('x', {}, { client: c });
  const off = await ex.clockOffset();
  assert.ok(Math.abs(off - 2500) < 50, String(off));
  setClockOffset(off);
  assert.ok(Math.abs(nowSynced() - Date.now() - 2500) < 50);
  setClockOffset(0);
});

// ---------- 9. Ліміти експозиції і резерв ----------

test('загальний ліміт позицій і ліміт на біржу обмежують розмір', async () => {
  const { trader, window, state, cfg } = await setup({ maxTradeUsdt: 1000, maxTotalUsdt: 120 });
  const cap = await trader.estimateCapacity(await window());
  assert.equal(cap.limitedBy, 'загальний ліміт позицій');
  assert.ok(Math.abs(cap.base * cap.mid - 120) < 1);
  cfg.maxTotalUsdt = 0;
  cfg.maxExchangeUsdt = 80;
  state.positions.push({ symbol: 'X/USDT:USDT', shortEx: 'a', longEx: 'c', base: 0.5, short: { entry: 100 }, long: { entry: 100 } });
  const cap2 = await trader.estimateCapacity(await window());
  assert.equal(cap2.limitedBy, 'ліміт біржі a');
  assert.ok(Math.abs(cap2.base * cap2.mid - 30) < 1, 'на біржі a вже 50 з 80');
});

test('резерв балансу: бот не використовує 20% вільного балансу', async () => {
  const { a, trader, window } = await setup({ maxTradeUsdt: 10000, reservePct: 0.2 });
  a.client.fetchBalance = async () => ({ free: { USDT: 100 } });
  const cap = await trader.estimateCapacity(await window());
  assert.equal(cap.limitedBy, 'баланс a ×3');
  assert.ok(Math.abs(cap.raw * cap.mid - 240) < 1, String(cap.raw * cap.mid)); // 100 × 3 × 0.8
});

// ---------- 11. Тестові мережі ----------

test('SANDBOX: кожна біржа йде у своє тестове середовище (Bybit — Demo Trading, Bitget — PAPTRADING)', () => {
  const env = (id, ov) => {
    const e = new Exchange(id, {});
    return e.enableSandbox(ov) ? `${e.testEnv} ${JSON.stringify(e.client.urls.api)}` : 'немає';
  };
  assert.match(env('binance'), /^sandbox .*testnet\.binancefuture\.com/);
  assert.match(env('binance', 'demo'), /^demo .*demo-fapi\.binance\.com/);
  assert.match(env('bybit'), /^demo .*api-demo\./, 'Bybit — Demo Trading, а не Testnet');
  assert.doesNotMatch(env('bybit'), /api-testnet/);
  const okx = new Exchange('okx', {});
  okx.enableSandbox();
  assert.equal(okx.client.headers['x-simulated-trading'], '1');
  const bg = new Exchange('bitget', {});
  assert.ok(bg.enableSandbox());
  assert.equal(bg.client.options.sandboxMode, true, 'Bitget демо — заголовок PAPTRADING');
  assert.match(env('bingx'), /open-api-vst/);
  assert.match(env('kraken'), /demo-futures\.kraken\.com/);
  assert.equal(env('kucoin'), 'немає');
  assert.equal(env('htx'), 'немає');
});

// ---------- Підтвердження нарахування фандінгу ----------

test('live: не виходимо, доки біржа не покаже нарахування фандінгу (або не мине fundingConfirmSec)', async () => {
  const { a, b, state, trader, rates, window, at } = await setup({ fundingConfirmSec: 90 });
  assert.ok(await trader.tryOpen(await window()));
  at(115000); // виплата була 15 с тому, ціни зійшлися, але нарахування ще не видно
  await trader.manage(await rates());
  assert.equal(state.positions.length, 1, 'чекаємо підтвердження');
  a.client.funding = [{ symbol: SYM, timestamp: Date.now() + 100000, amount: 0.75 }];
  at(125000);
  await trader.manage(await rates());
  assert.equal(state.positions.length, 1, 'на b ще не підтверджено');
  at(100000 + 91000); // минуло 90 с — беремо розрахунок
  await trader.manage(await rates());
  assert.equal(state.positions.length, 0);
  const c = state.data.closed[0];
  assert.ok(c.unconfirmedFunding);
  const ev = c.events.find((e) => e.ex === 'a');
  assert.equal(ev.confirmed, true);
  assert.equal(ev.amount, 0.75);
  assert.ok(b);
});

test('фандінг систематично не збігається з розрахунком — біржу блокуємо, /unblock знімає', async () => {
  const { a, trader, msgs } = await setup();
  await trader.checkFundingMatch('a', 1, 0.98, SYM);
  assert.ok(!a.tradeBlocked);
  await trader.checkFundingMatch('a', 1, -1, SYM); // інший знак
  assert.ok(!a.tradeBlocked, 'одна розбіжність — лише попередження');
  assert.match(msgs.at(-1), /замість розрахованих/);
  await trader.checkFundingMatch('a', 1, 10, SYM); // у 10 разів більше (масштаб ставки?)
  assert.match(a.tradeBlocked, /не збігається/);
  assert.match(msgs.at(-1), /заблоковано/);
});

// ---------- Фактичні комісії ----------

test('фактичні комісії акаунта замість базових', async () => {
  const { a, trader, window, cfg } = await setup();
  a.client.has.fetchTradingFee = true;
  a.client.fetchTradingFee = async () => ({ taker: 0.0002 });
  assert.equal(a.takerFee(SYM), 0.0005);
  assert.ok(await trader.tryOpen(await window()));
  assert.equal(a.takerFee(SYM), 0.0002);
  assert.ok(cfg);
});

// ---------- Техроботи ----------

test('техроботи на біржі — не входимо', async () => {
  const { a, trader, window } = await setup();
  a.client.has.fetchStatus = true;
  a.client.fetchStatus = async () => ({ status: 'maintenance' });
  await a.checkStatus();
  assert.match(a.maintenance, /maintenance/);
  assert.equal(await trader.tryOpen(await window()), false);
  a.client.fetchStatus = async () => ({ status: 'ok' });
  await a.checkStatus();
  assert.equal(a.maintenance, undefined);
});

// ---------- Самоперевірка ----------

test('самоперевірка: безпечна і повна; критична помилка блокує біржу', async () => {
  const { a } = await setup();
  a.client.markets[SYM].limits.amount.min = 0.001;
  let r = await a.runSelfTest();
  assert.ok(r.ok, JSON.stringify(r.checks));
  assert.ok(r.checks.find((c) => c.name.startsWith('права на торгівлю')).ok);
  assert.equal(a.client.orders.at(-1).type, 'limit');
  assert.equal(a.client.pos[SYM] || 0, 0, 'IOC не виконався — позиції немає');
  a.client.limitFill = 0;
  r = await a.runSelfTest({ full: true });
  assert.ok(r.ok, JSON.stringify(r.checks));
  assert.ok(r.checks.find((c) => c.name === 'стоп-ордер на біржі').ok);
  assert.equal(a.client.stops.at(-1).active, false, 'тестовий стоп знято');
  assert.equal(a.client.pos[SYM], 0, 'тестову позицію закрито');
  a.client.stopFail = true;
  r = await a.runSelfTest({ full: true });
  assert.equal(r.ok, false);
  a.client.fetchBalance = async () => ({ free: { USDT: 0 }, total: { USDT: 0 } });
  r = await a.runSelfTest();
  assert.equal(r.ok, false);
  assert.match(r.checks[0].info, /вільний баланс 0/);
});

// ---------- Автобан монети ----------

test('3 збиткові угоди поспіль по монеті — монета в чорному списку', async () => {
  const { CoinRegistry } = require('../src/coins');
  const { trader, state, msgs } = await setup({ autoBanLosses: 3 });
  trader.coins = new CoinRegistry({ coinPriceTol: 0.03 }, null);
  for (const pnl of [-1, -2]) state.data.closed.push({ symbol: SYM, pnl });
  await trader.maybeAutoBan(SYM);
  assert.ok(!trader.coins.isBanned('ETH', 'a'));
  state.data.closed.push({ symbol: SYM, pnl: -0.5 });
  await trader.maybeAutoBan(SYM);
  assert.ok(trader.coins.isBanned('ETH', 'a'));
  assert.match(msgs.at(-1), /автоматично додано в чорний список/);
});

test('самоперевірка не чіпає монети, по яких бот має позицію (one-way підсумував би угоди)', async () => {
  const { a } = await setup();
  const ETH = 'ETH/USDT:USDT';
  a.client.markets['BTC/USDT:USDT'] = { ...a.client.markets[ETH], symbol: 'BTC/USDT:USDT', base: 'BTC' };
  a.buildSymbolMap();
  a.client.pos[ETH] = -1.5; // бойова позиція бота
  const r = await a.runSelfTest({ full: true, avoid: [ETH] });
  assert.ok(r.ok, JSON.stringify(r.checks));
  assert.ok(a.client.orders.every((o) => o.s === 'BTC/USDT:USDT'), 'тест лише по BTC');
  assert.equal(a.client.pos[ETH], -1.5, 'бойова позиція не змінилась');
  // єдина монета зайнята — повний тест пропускається
  const r2 = await a.runSelfTest({ full: true, avoid: [ETH, 'BTC/USDT:USDT'] });
  assert.equal(r2.ok, false);
  assert.match(r2.checks[0].info, /усі монети зайняті/);
});

test('самоперевірка: немає права на торгівлю — критично; немає коштів — права є', async () => {
  const { a } = await setup();
  a.client.markets[SYM].limits.amount.min = 0.001;
  const orig = a.client.createOrder.bind(a.client);
  a.client.createOrder = async () => { throw new Error('okx {"msg":"This API key doesn\'t have permission to use this function","code":"50120"}'); };
  let r = await a.runSelfTest();
  assert.equal(r.ok, false);
  assert.match(r.checks.find((c) => c.name.startsWith('права')).info, /немає права на торгівлю/);
  a.client.createOrder = async () => { throw new Error('binance {"code":-2019,"msg":"Margin is insufficient."}'); };
  r = await a.runSelfTest();
  assert.ok(r.ok);
  assert.match(r.checks.find((c) => c.name.startsWith('права')).info, /права на торгівлю є/);
  a.client.createOrder = orig;
});

test('вхід з несприятливою різницею цін: сходження до 0 — збиток, тож чекаємо повернення до рівня входу', async () => {
  const { a, state, trader, rates, window, at, msgs } = await setup({ maxEntryBasisPct: 0.005 });
  a.client.price = 99.7; // біржа шорту дешевша на ~0.3%: продаємо дешевше, ніж купуємо
  assert.ok(await trader.tryOpen(await window()));
  const pos = state.positions[0];
  assert.ok(pos.entryBasis < -0.002, String(pos.entryBasis));
  a.client.funding = [{ symbol: SYM, timestamp: Date.now() + 100000, amount: 0.5 }];
  const b = trader.ex.b;
  b.client.funding = [{ symbol: SYM, timestamp: Date.now() + 100000, amount: -0.1 }];
  a.client.price = 100; // після виплати ціни «зійшлися» до 0 — для цієї угоди це −0.3%
  at(115000);
  await trader.manage(await rates());
  assert.equal(state.positions.length, 1, 'не фіксуємо збиток на сходженні');
  a.client.price = 99.7; // різниця повернулась до рівня входу
  at(130000);
  await trader.manage(await rates());
  assert.equal(state.positions.length, 0);
  const exit = msgs.find((m) => m.includes('ВИХІД'));
  assert.match(exit, /ціни зійшлися .*на вході була -0\.3/);
  assert.match(exit, /Різниця цін між біржами: на вході -0\.3\d*%, на виході -0\.3/);
});
