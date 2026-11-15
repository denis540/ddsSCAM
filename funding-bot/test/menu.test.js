'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { Telegram, COMMANDS, HELP } = require('../src/telegram');
const { Settings, SCHEMA } = require('../src/settings');
const { State } = require('../src/state');
const { KeyStore } = require('../src/keys');
const { CoinRegistry } = require('../src/coins');
const { Exchange } = require('../src/exchange');
const { fakeClient } = require('./helpers');

async function setup() {
  const cfg = { minFunding: 0.001, minProfit: 0.0005, entryBeforeSec: 120, exitAfterSec: 120, convergePct: 0.0005, earlyExit: true,
    leverage: 3, maxPositions: 3, sizeMode: 'coins', coinQty: {}, positionUsdt: 100, whitelist: [], blacklist: [], reportTime: '23:55',
    paused: false, marginMode: 'isolated', timezone: 'Europe/Kyiv', mode: 'live', exchanges: ['okx'], quote: 'USDT', coinPriceTol: 0.03, strictCoins: false };
  const client = fakeClient();
  client.fetchBalance = async () => ({ free: { USDT: 10 }, total: { USDT: 10 } });
  const okx = new Exchange('okx', {}, { client });
  await okx.init();
  const tg = new Telegram({ token: 't', chatIds: ['42'] });
  const out = [];
  const api = [];
  tg.send = async (text, chatId, markup) => { out.push({ text, markup }); };
  tg.api = async (m, b) => { api.push([m, b]); return {}; };
  const trader = { openNotional: () => 0, withLock: (fn) => fn(), busy: new Set() };
  const reconciler = { run: async () => ({ orphans: [], mismatches: [], autoClosed: [], failed: [] }), closeOrphan: async () => 'ok' };
  tg.ctx = { cfg, settings: new Settings(cfg, null), state: new State(null), trader, reconciler, keys: new KeyStore({}, null),
    all: { okx }, exchanges: { okx }, initErrors: {}, coins: new CoinRegistry(cfg, null),
    getRates: () => ({ okx: { 'ETH/USDT:USDT': { rate: 0.001, intervalH: 8, mark: 100, nextTs: Date.now() + 1e5 } } }),
    getOpps: () => [], getLastScanAt: () => undefined };
  const buttons = () => (out.at(-1).markup && out.at(-1).markup.inline_keyboard ? out.at(-1).markup.inline_keyboard.flat() : []);
  return { cfg, tg, out, api, okx, buttons };
}

test('усі команди мають валідні назви для меню Telegram і є в /help', () => {
  const all = COMMANDS.flatMap(([, l]) => l);
  assert.ok(all.length <= 100);
  for (const [c, d] of all) {
    assert.match(c, /^[a-z0-9_]{1,32}$/);
    assert.ok(d.length > 0 && d.length <= 256);
    assert.ok(HELP.includes(`/${c} — `), c);
  }
});

test('/menu і кнопка «🏠 Меню» показують кнопки, кожна кнопка обробляється', async () => {
  const { tg, out, buttons } = await setup();
  await tg.handle('🏠 Меню', '42');
  const btns = buttons();
  assert.ok(btns.length >= 12);
  for (const b of btns) {
    const before = out.length;
    await tg.handleCallback(b.callback_data, '42');
    assert.ok(out.length > before, `кнопка ${b.text} нічого не відповіла`);
    assert.ok(!/Невідома дія|Не зрозумів/.test(out.at(-1).text), `${b.text}: ${out.at(-1).text}`);
  }
});

test('налаштування кнопками: натиснути параметр → надіслати значення', async () => {
  const { cfg, tg, out, buttons } = await setup();
  await tg.handle('⚙️ Налаштування', '42');
  assert.equal(buttons().filter((b) => b.callback_data.startsWith('set:')).length, Object.keys(SCHEMA).length);
  await tg.handleCallback('set:minfunding', '42');
  assert.match(out.at(-1).text, /Надішліть нове значення/);
  await tg.handle('0,7', '42');
  assert.equal(cfg.minFunding, 0.007);
  assert.match(out.at(-1).text, /Мін. фандінг = 0.7%/);
  // on/off — одразу кнопками
  await tg.handleCallback('set:earlyexit', '42');
  assert.deepEqual(buttons().map((b) => b.callback_data).slice(0, 2), ['sv:earlyexit:on', 'sv:earlyexit:off']);
  await tg.handleCallback('sv:earlyexit:off', '42');
  assert.equal(cfg.earlyExit, false);
  // помилкове значення не ламає
  await tg.handleCallback('set:leverage', '42');
  await assert.rejects(tg.handle('abc', '42'), /число/);
  // команда скасовує очікування
  await tg.handleCallback('set:maxpos', '42');
  await tg.handle('/status', '42');
  await tg.handle('7', '42');
  assert.equal(cfg.maxPositions, 3);
});

test('ключ біржі через кнопки: повідомлення з ключем видаляється', async () => {
  const { tg, out, api, okx } = await setup();
  await tg.handleCallback('ex:okx', '42');
  assert.match(out.at(-1).text, /passphrase/);
  await tg.handleCallback('key:okx', '42');
  await tg.handle('KEY12345 SECRET PASS', '42', 99);
  assert.ok(api.some(([m, b]) => m === 'deleteMessage' && b.message_id === 99));
  assert.match(out.at(-1).text, /збережено і перевірено/);
  assert.ok(okx.hasKeys);
});

test('монети: перевірка через кнопку, кількість через кнопку', async () => {
  const { cfg, tg, out, buttons } = await setup();
  await tg.handleCallback('coinask', '42');
  await tg.handle('eth', '42');
  assert.match(out.at(-1).text, /🪙 ETH/);
  assert.match(out.at(-1).text, /OKX: ETH, ціна 100/);
  assert.ok(buttons().some((b) => b.callback_data === 'coinban:ETH'));
  await tg.handleCallback('coinban:ETH', '42');
  assert.ok(tg.ctx.coins.isBanned('ETH', 'okx'));
  await tg.handleCallback('qtyadd', '42');
  await tg.handle('BTC 0.01\nETH 0.5', '42');
  assert.deepEqual(cfg.coinQty, { BTC: 0.01, ETH: 0.5 });
  await tg.handleCallback('qtydel:BTC', '42');
  assert.deepEqual(cfg.coinQty, { ETH: 0.5 });
});

test('Telegram: Id, якому не можна писати, — одне зрозуміле попередження з Id, інші отримують повідомлення', async () => {
  const log = require('../src/logger');
  const tg = new Telegram({ token: 't', chatIds: ['42', '777'] });
  const sentTo = [];
  tg.api = async (m, b) => {
    if (b.chat_id === '777') throw new Error('sendMessage: Bad Request: chat not found');
    sentTo.push(b.chat_id);
    return {};
  };
  const warns = [];
  const orig = log.warn;
  log.warn = (m) => { warns.push(String(m)); };
  try {
    await tg.send('перше');
    await tg.send('друге');
  } finally {
    log.warn = orig;
  }
  assert.deepEqual(sentTo, ['42', '42'], 'основний отримувач отримує все');
  assert.equal(warns.length, 1, 'попередження одне, без спаму');
  assert.match(warns[0], /Id 777/);
  assert.match(warns[0], /не натиснув Start/);
});
