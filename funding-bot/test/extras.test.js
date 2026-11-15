'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runBacktest } = require('../src/backtest');
const { acquireLock } = require('../src/lock');
const { Telegram } = require('../src/telegram');
const { Settings } = require('../src/settings');
const { State } = require('../src/state');
const { KeyStore } = require('../src/keys');
const R = require('../src/report');
const { makeExchange } = require('./helpers');

const H = 3600000;

test('перевірка на історії: одночасні виплати і виплата лише на одній біржі, комісії, ліміт угод', async () => {
  const a = await makeExchange('a');
  const b = await makeExchange('b');
  const T = Math.floor(Date.now() / (8 * H)) * 8 * H;
  // a: 8h, b: 4h. У T-16h: a 0.5%, b 0.1% (одночасно) → 0.4%; у T-12h: лише b −0.3% (LONG на b отримує) → 0.3%
  a.client.has.fetchFundingRateHistory = true;
  b.client.has.fetchFundingRateHistory = true;
  a.client.fetchFundingRateHistory = async () => [
    { timestamp: T - 24 * H, fundingRate: 0.0001 }, { timestamp: T - 16 * H, fundingRate: 0.005 }, { timestamp: T - 8 * H, fundingRate: 0.0001 },
  ];
  b.client.fetchFundingRateHistory = async () => [
    { timestamp: T - 24 * H, fundingRate: 0.0001 }, { timestamp: T - 20 * H, fundingRate: 0.0001 }, { timestamp: T - 16 * H, fundingRate: 0.001 },
    { timestamp: T - 12 * H, fundingRate: -0.003 }, { timestamp: T - 8 * H, fundingRate: 0.0001 },
  ];
  const cfg = { minFunding: 0.001, minProfit: 0, maxPositions: 3, maxAbsFundingRate: 0.1, whitelist: [], blacklist: [], coinQty: {},
    sizeMode: 'auto', maxTradeUsdt: 100, leverage: 3, quote: 'USDT' };
  const r = await runBacktest({ exchanges: { a, b }, cfg, days: 2, now: T });
  assert.equal(r.trades.length, 2);
  const [t1, t2] = r.trades;
  assert.equal(t1.shortEx, 'a');
  assert.ok(Math.abs(t1.funding - 0.004) < 1e-12);
  assert.ok(Math.abs(t1.net - 0.002) < 1e-12); // мінус 4 × 0.05%
  assert.equal(t2.longEx, 'b');
  assert.ok(Math.abs(t2.funding - 0.003) < 1e-12);
  assert.ok(Math.abs(r.usdt - (0.002 + 0.001) * 300) < 1e-9);
  assert.match(r.text, /Угод: 2/);
  assert.match(r.text, /оцінка «зверху»/);
});

test('замок: друга копія бота не стартує, «мертвий» замок перехоплюється', () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fb-')), 'bot.lock');
  fs.writeFileSync(f, String(process.ppid)); // живий процес
  assert.throws(() => acquireLock(f), /бот уже запущено/);
  fs.writeFileSync(f, '999999'); // процесу немає
  const release = acquireLock(f);
  assert.equal(fs.readFileSync(f, 'utf8'), String(process.pid));
  release();
  assert.ok(!fs.existsSync(f));
});

async function tgSetup(pin) {
  const cfg = { minFunding: 0.001, leverage: 3, maxPositions: 3, sizeMode: 'auto', coinQty: {}, whitelist: [], blacklist: [], paused: true,
    mode: 'live', quote: 'USDT', timezone: 'Europe/Kyiv', reportTime: '23:55', marginMode: 'isolated', exchanges: [] };
  const tg = new Telegram({ token: 't', chatIds: ['42'], pin });
  const out = [];
  const api = [];
  tg.send = async (text, c, markup) => { out.push({ text, markup }); };
  tg.api = async (m, b) => { api.push([m, b]); return {}; };
  const state = new State(null);
  tg.ctx = { cfg, settings: new Settings(cfg, null), state, keys: new KeyStore({}, null), all: {}, exchanges: {}, guard: null,
    trader: { withLock: (f) => f(), openNotional: () => 0 }, getRates: () => ({}), getOpps: () => [], getLastScanAt: () => undefined };
  return { cfg, tg, out, api, state };
}

test('PIN: небезпечні дії лише після PIN; повідомлення з PIN видаляється; 5 помилок — блокування', async () => {
  const { cfg, tg, out, api } = await tgSetup('4321');
  await tg.handle('/status', '42');
  assert.doesNotMatch(out.at(-1).text, /PIN/, 'безпечні команди без PIN');
  await tg.handle('/set leverage 10', '42');
  assert.match(out.at(-1).text, /потребує PIN/);
  assert.equal(cfg.leverage, 3);
  await tg.handle('1111', '42', 7);
  assert.match(out.at(-1).text, /Невірний PIN/);
  assert.equal(cfg.leverage, 3);
  await tg.handle('/set leverage 10', '42');
  await tg.handle('4321', '42', 8);
  assert.equal(cfg.leverage, 10, 'після PIN дія виконана');
  assert.deepEqual(api.filter(([m]) => m === 'deleteMessage').map(([, b]) => b.message_id), [7, 8]);
  await tg.handle('/set maxpos 1', '42');
  assert.equal(cfg.maxPositions, 1, '10 хв без повторного PIN');
  // кнопки налаштувань теж під PIN
  const t2 = await tgSetup('4321');
  await t2.tg.handleCallback('sv:earlyexit:off', '42');
  assert.match(t2.out.at(-1).text, /потребує PIN/);
  for (let i = 0; i < 5; i++) {
    await t2.tg.handle('/resume', '42');
    await t2.tg.handle('0000', '42');
  }
  assert.match(t2.out.at(-1).text, /заблоковано на 15 хв/);
  await t2.tg.handle('/resume', '42');
  assert.match(t2.out.at(-1).text, /Спробуйте після/);
  assert.ok(t2.cfg.paused);
});

test('без PIN у налаштуваннях — дії виконуються одразу', async () => {
  const { cfg, tg } = await tgSetup('');
  await tg.handle('/set leverage 5', '42');
  assert.equal(cfg.leverage, 5);
});

test('статистика і CSV-експорт угод', async () => {
  const { tg, out, state } = await tgSetup('');
  const now = Date.now();
  state.data.closed.push(
    { symbol: 'ETH/USDT:USDT', shortEx: 'okx', longEx: 'binance', base: 1, leverage: 3, short: { entry: 100 }, long: { entry: 100 }, exitShort: 100, exitLong: 100,
      fundingAccrued: 2, feesPaid: 0.1, closeFees: 0.1, pricePnl: -0.2, pnl: 1.6, closedAt: now, openedAt: now - 300000, slipEntry: 0.0002, slipExit: 0.0001, reason: 'ціни, зійшлися' },
    { symbol: 'PEPE/USDT:USDT', shortEx: 'bybit', longEx: 'okx', base: 1e6, pnl: -0.5, closedAt: now, short: {}, long: {}, reason: 'x' }
  );
  const st = R.formatStats(state, { quote: 'USDT' });
  assert.match(st, /Угод: 2, прибуткових 50%/);
  assert.match(st, /okx\/binance: 1 угод, PnL \+1\.6/);
  assert.match(st, /Проковзування .*вхід 0\.020%/);
  const csv = R.tradesCsv(state, 30);
  const lines = csv.trim().split('\n');
  assert.equal(lines.length, 3);
  assert.match(lines[0], /^closed_at_utc,/);
  assert.match(lines[1], /"ціни, зійшлися"$/);
  let doc;
  tg.sendDocument = async (c, name, content) => { doc = { name, content }; };
  await tg.handle('/export 30', '42');
  assert.match(doc.name, /^trades_.*_30d\.csv$/);
  state.data.closed = [];
  await tg.handle('/export 30', '42');
  assert.match(out.at(-1).text, /закритих угод немає/);
});

test('збереження стану не падає, навіть якщо файл заблоковано (Windows: антивірус, OneDrive)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-'));
  const file = path.join(dir, 'state.json');
  const st = new State(file);
  st.data.stats.trades = 7;
  const orig = fs.renameSync;
  let calls = 0;
  fs.renameSync = (...a) => {
    calls += 1;
    if (calls <= 2) { const e = new Error('busy'); e.code = 'EBUSY'; throw e; }
    return orig(...a);
  };
  try {
    st.save(); // 2 невдалі спроби, потім успіх
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).stats.trades, 7);
    fs.renameSync = () => { const e = new Error('perm'); e.code = 'EPERM'; throw e; };
    st.data.stats.trades = 8;
    assert.doesNotThrow(() => st.save()); // замінити не вдалось — пише напряму
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).stats.trades, 8);
  } finally {
    fs.renameSync = orig;
  }
});

test('перевірка на історії бере монети з найбільшою різницею ставок, а не лише найбільші за обсягом', async () => {
  const { pickCoins } = require('../src/backtest');
  const mk = (vols) => ({
    perpSymbols: () => Object.keys(vols),
    tickers: Object.fromEntries(Object.entries(vols).map(([s, v]) => [s, { volumeUsdt: v }])),
  });
  const S = (c) => `${c}/USDT:USDT`;
  const vols = { [S('BTC')]: 9e9, [S('ETH')]: 8e9, [S('SOL')]: 7e9, [S('SOPH')]: 5e6, [S('TINY')]: 1e5 };
  const exchanges = { a: mk(vols), b: mk(vols) };
  const r = (rate) => ({ rate, intervalH: 8 });
  const rates = {
    a: { [S('BTC')]: r(0.0001), [S('ETH')]: r(0.0001), [S('SOL')]: r(0.0001), [S('SOPH')]: r(-0.005), [S('TINY')]: r(-0.03) },
    b: { [S('BTC')]: r(0.0001), [S('ETH')]: r(0.0001), [S('SOL')]: r(0.0001), [S('SOPH')]: r(0.005), [S('TINY')]: r(0.03) },
  };
  const cfg = { whitelist: [], blacklist: [], sizeMode: 'auto', coinQty: {}, minVolumeUsdt: 1e6 };
  const picked = pickCoins(exchanges, cfg, 2, rates);
  assert.deepEqual(picked, [S('SOPH'), S('BTC')], 'SOPH — за різницею ставок, BTC — за обсягом; TINY відсіяно за малим обсягом');
  assert.deepEqual(pickCoins(exchanges, cfg, 2), [S('BTC'), S('ETH')], 'без ставок — як раніше, за обсягом');
});
