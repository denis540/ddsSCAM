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
