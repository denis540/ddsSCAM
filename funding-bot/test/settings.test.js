'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Settings } = require('../src/settings');
const { Telegram } = require('../src/telegram');
const { State } = require('../src/state');

const mkCfg = () => ({ minFunding: 0.001, entryBeforeSec: 120, exitAfterSec: 120, convergePct: 0.0005, earlyExit: true, minProfit: 0.0005, timezone: 'Europe/Kyiv', leverage: 3, maxPositions: 3, sizeMode: 'coins', coinQty: {}, positionUsdt: 100,
  whitelist: [], blacklist: [], reportTime: '23:55', paused: false, marginMode: 'isolated' });

test('settings: зміна, валідація, збереження і відновлення', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fb-')), 's.json');
  const cfg = mkCfg();
  const s = new Settings(cfg, file);
  assert.equal(s.set('minfunding', '0,5'), '0.5%');
  assert.equal(cfg.minFunding, 0.005);
  s.set('entrybefore', '90');
  s.set('earlyexit', 'off');
  assert.throws(() => s.set('earlyexit', 'maybe'), /on або off/);
  s.set('leverage', '5');
  s.set('maxpos', '7');
  s.set('whitelist', 'btc,eth');
  s.setQty('btc', '0.01');
  s.setPaused(true);
  assert.throws(() => s.set('leverage', '2.5'), /ціле/);
  assert.throws(() => s.set('leverage', '0'), /мінімум/);
  assert.throws(() => s.set('sizemode', 'abc'), /coins, usdt/);
  assert.throws(() => s.set('nope', '1'), /невідомий/);

  const cfg2 = mkCfg();
  new Settings(cfg2, file);
  assert.equal(cfg2.minFunding, 0.005);
  assert.equal(cfg2.entryBeforeSec, 90);
  assert.equal(cfg2.earlyExit, false);
  assert.equal(cfg2.leverage, 5);
  assert.equal(cfg2.maxPositions, 7);
  assert.deepEqual(cfg2.whitelist, ['BTC', 'ETH']);
  assert.deepEqual(cfg2.coinQty, { BTC: 0.01 });
  assert.equal(cfg2.paused, true);
});

test('telegram: команди змінюють налаштування', async () => {
  const cfg = { ...mkCfg(), mode: 'paper', exchanges: ['a', 'b'], quote: 'USDT' };
  const settings = new Settings(cfg, null);
  const state = new State(null, 'Europe/Kyiv');
  const tg = new Telegram({ token: 't', chatIds: ['42'] });
  const sent = [];
  tg.send = async (t) => { sent.push(t); };
  tg.ctx = { cfg, settings, state, trader: {}, getRates: () => ({}), getOpps: () => [], getLastScanAt: () => undefined };

  await tg.handle('/set minfunding 2', '42');
  assert.equal(cfg.minFunding, 0.02);
  await tg.handle('/set exitafter 60', '42');
  assert.equal(cfg.exitAfterSec, 60);
  await tg.handle('/qty SOL 5', '42');
  assert.equal(cfg.coinQty.SOL, 5);
  await tg.handle('⏸ Пауза', '42');
  assert.equal(cfg.paused, true);
  await tg.handle('📊 Статус', '42');
  assert.match(sent.at(-1), /ПАУЗА/);
  await tg.handle('💰 Звіт', '42');
  assert.match(sent.at(-1), /ЗАГАЛЬНИЙ PnL/);
  await tg.handle('/settings', '42');
  assert.match(sent.at(-1), /minfunding = 2%/);
});

test('telegram: повідомлення з чужого чату ігноруються', async () => {
  const tg = new Telegram({ token: 't', chatIds: ['42'] });
  const handled = [];
  tg.handle = async (text, chatId) => { handled.push([text, chatId]); };
  let calls = 0;
  tg.api = async (method) => {
    if (method !== 'getUpdates') return {};
    if (++calls > 1) { tg.stopped = true; return []; }
    return [
      { update_id: 1, message: { chat: { id: 666 }, text: '/closeall yes' } },
      { update_id: 2, message: { chat: { id: 42 }, text: '/status' } },
    ];
  };
  await tg.poll();
  assert.deepEqual(handled, [['/status', '42']]);
});

test('telegram: /setkey перевіряє ключ, зберігає, видаляє повідомлення; /delkey', async () => {
  const { KeyStore } = require('../src/keys');
  const { Exchange } = require('../src/exchange');
  const { fakeClient } = require('./helpers');
  const cfg = { ...mkCfg(), mode: 'live', exchanges: ['okx'], quote: 'USDT' };
  const client = fakeClient();
  let balanceOk = true;
  client.fetchBalance = async () => { if (!balanceOk) throw new Error('Invalid API key'); return { free: { USDT: 77 }, total: { USDT: 80 } }; };
  const okx = new Exchange('okx', {}, { client });
  await okx.init();
  const keys = new KeyStore({}, null);
  const tg = new Telegram({ token: 't', chatIds: ['42'] });
  const sent = [];
  const api = [];
  tg.send = async (t) => { sent.push(t); };
  tg.api = async (m, b) => { api.push([m, b]); return {}; };
  tg.ctx = { cfg, settings: new Settings(cfg, null), state: new State(null), trader: {}, keys, all: { okx }, exchanges: { okx }, initErrors: {},
    getRates: () => ({}), getOpps: () => [], getLastScanAt: () => undefined };

  await tg.handle('/setkey okx AAAA1111 SECRET', '42', 5);
  assert.match(sent.at(-1), /потребує passphrase/);
  await tg.handle('/setkey okx AAAA1111 SECRET PASS', '42', 6);
  assert.deepEqual(api.filter(([m]) => m === 'deleteMessage').map(([, b]) => b.message_id), [5, 6]);
  assert.match(sent.at(-1), /збережено і перевірено. Баланс: 77.00/);
  assert.equal(keys.get('okx').password, 'PASS');
  assert.ok(okx.hasKeys);

  balanceOk = false;
  await tg.handle('/setkey okx BAD BAD BAD', '42', 7);
  assert.match(sent.at(-1), /не працює/);
  assert.equal(keys.get('okx').apiKey, 'AAAA1111', 'невдалий ключ не перезаписує робочий');
  assert.equal(okx.client.apiKey, 'AAAA1111');

  balanceOk = true;
  await tg.handle('🏦 Біржі', '42');
  assert.match(sent.at(-1), /OKX: 1 монет, 🔑 AAAA…1111 \(telegram\)/);
  assert.match(sent.at(-1), /Binance: вимкнена/);
  await tg.handle('💵 Баланс', '42');
  assert.match(sent.at(-1), /OKX: вільно 77.00/);
  await tg.handle('/delkey okx', '42');
  assert.ok(!okx.hasKeys);
});
