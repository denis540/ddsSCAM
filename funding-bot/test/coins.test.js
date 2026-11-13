'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { CoinRegistry, extractAddresses, normNet } = require('../src/coins');
const { Exchange, parseMultiplier } = require('../src/exchange');
const { Trader } = require('../src/trader');
const { State } = require('../src/state');
const { planWindows, dueWindows } = require('../src/scanner');
const { fakeClient } = require('./helpers');

const cfg = { coinPriceTol: 0.03, strictCoins: false };

test('адреси контрактів з різних форматів бірж', () => {
  // Binance-подібний: networks[код].info.contractAddress
  const binance = { networks: { BSC: { network: 'BSC', info: { contractAddress: '0xAAAA00000000000000000000000000000000BBBB' } }, ETH: { network: 'ETH', info: { contractAddress: '0x1111000000000000000000000000000000002222' } } } };
  assert.deepEqual(extractAddresses(binance), { BEP20: '0xaaaa00000000000000000000000000000000bbbb', ERC20: '0x1111000000000000000000000000000000002222' });
  // OKX-подібний: ctAddr
  const okx = { networks: { ERC20: { network: 'ERC20', info: { ctAddr: '0x1111000000000000000000000000000000002222' } } } };
  assert.deepEqual(extractAddresses(okx), { ERC20: '0x1111000000000000000000000000000000002222' });
  // KuCoin/Bitget-подібний: info.chains[]
  const kucoin = { info: { chains: [{ chainName: 'Solana', contractAddress: 'So1anaMint1111111111111111111111111111' }] } };
  assert.deepEqual(extractAddresses(kucoin), { SOL: 'so1anamint1111111111111111111111111111' });
  // нативна монета без контракту
  assert.deepEqual(extractAddresses({ networks: { BTC: { info: { contractAddress: '' } } } }), {});
  assert.equal(normNet('BNB Smart Chain'), 'BEP20');
});

test('check: та сама / різні монети за адресою, ціною і ручними рішеннями', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fb-')), 'coins.json');
  const reg = new CoinRegistry({ ...cfg }, file);
  reg.addresses = {
    binance: { NEIRO: { ERC20: '0xaaa' }, PEPE: { ERC20: '0xpepe' } },
    okx: { NEIRO: { ERC20: '0xbbb' }, PEPE: { ERC20: '0xpepe', BEP20: '0xother' } },
    bybit: {},
  };
  assert.equal(reg.check('PEPE', 'binance', 'okx', 1, 1.001).status, 'confirmed');
  const n = reg.check('NEIRO', 'binance', 'okx', 1, 1);
  assert.equal(n.ok, false);
  assert.match(n.reason, /різні адреси контракту \(ERC20\)/);
  // адрес немає — вирішує ціна
  assert.equal(reg.check('NEIRO', 'binance', 'bybit', 1, 1.02).ok, true);
  const p = reg.check('NEIRO', 'binance', 'bybit', 1, 1.5);
  assert.equal(p.ok, false);
  assert.match(p.reason, /ціни відрізняються на 50\.0%/);
  // суворий режим: лише підтверджені
  reg.cfg.strictCoins = true;
  assert.equal(reg.check('NEIRO', 'binance', 'bybit', 1, 1).ok, false);
  assert.equal(reg.check('PEPE', 'binance', 'okx', 1, 1).ok, true);
  reg.cfg.strictCoins = false;
  // ручні рішення зберігаються у файл
  reg.trust('NEIRO');
  assert.equal(reg.check('NEIRO', 'binance', 'okx', 1, 1).ok, true);
  reg.ban('PEPE', 'okx');
  assert.equal(reg.check('PEPE', 'binance', 'okx', 1, 1).ok, false);
  assert.equal(reg.check('PEPE', 'binance', 'bybit', 1, 1).ok, true, 'заборона лише на okx');
  const reg2 = new CoinRegistry(cfg, file);
  assert.ok(reg2.isTrusted('NEIRO'));
  assert.ok(reg2.isBanned('PEPE', 'okx'));
  reg2.reset('PEPE');
  assert.ok(!reg2.isBanned('PEPE', 'okx'));
});

test('сканер не пропускає пару з різними монетами (навіть якщо різниця цін «вигідна»)', () => {
  const T = Date.now();
  const S = 'X/USDT:USDT';
  const base = { minFunding: 0.001, minProfit: 0, maxWindowHours: 8, allowEstimated: true, entryMinSec: 20, maxEntryBasisPct: 0.0015,
    maxAbsFundingRate: 0.1, whitelist: [], blacklist: [], defaultTakerFee: 0.0005, coinPriceTol: 0.03 };
  // на a ціна вдвічі вища: шорт по 20 і лонг по 10 виглядав би як +100% basis — це інша монета
  const rates = { a: { [S]: { rate: 0.01, nextTs: T + 100000, intervalH: 8, mark: 20 } }, b: { [S]: { rate: 0, nextTs: T + 100000, intervalH: 8, mark: 10 } } };
  assert.equal(planWindows(rates, base, undefined, T).length, 0);
  rates.a[S].mark = 10.1;
  assert.equal(planWindows(rates, base, undefined, T).length, 1);
  const reg = new CoinRegistry(cfg, null);
  reg.ban('X');
  assert.equal(planWindows(rates, base, undefined, T, (...a) => reg.check(...a)).length, 0);
});

test('parseMultiplier', () => {
  assert.deepEqual(parseMultiplier('1000PEPE'), { coin: 'PEPE', mult: 1000 });
  assert.deepEqual(parseMultiplier('1MBABYDOGE'), { coin: 'BABYDOGE', mult: 1e6 });
  assert.deepEqual(parseMultiplier('1000000MOG'), { coin: 'MOG', mult: 1e6 });
  assert.deepEqual(parseMultiplier('1INCH'), { coin: '1INCH', mult: 1 });
  assert.deepEqual(parseMultiplier('BTC'), { coin: 'BTC', mult: 1 });
});

test('1000PEPE на одній біржі ↔ PEPE на іншій: ціни і кількості перераховуються', async () => {
  const T0 = Date.now();
  // a: 1000PEPE, ціна за 1000 шт = 0.01, крок 1 контракт; b: PEPE, ціна 0.00001, контракт 1000 шт
  const ca = fakeClient({ price: 0.01, rate: 0.01, step: 1 });
  ca.markets = { '1000PEPE/USDT:USDT': { ...ca.markets['ETH/USDT:USDT'], symbol: '1000PEPE/USDT:USDT', base: '1000PEPE', contractSize: 1, limits: { amount: { min: 1 } } } };
  const cb = fakeClient({ price: 0.00001, rate: 0, step: 1 });
  cb.markets = { 'PEPE/USDT:USDT': { ...cb.markets['ETH/USDT:USDT'], symbol: 'PEPE/USDT:USDT', base: 'PEPE', contractSize: 1000, limits: { amount: { min: 1 } } } };
  for (const [c, sym] of [[ca, '1000PEPE/USDT:USDT'], [cb, 'PEPE/USDT:USDT']]) {
    c.next = T0 + 100000;
    c.fetchFundingRate = async function () { return { symbol: sym, fundingRate: this.rate, interval: '8h', markPrice: this.price, fundingTimestamp: this.next }; };
  }
  const a = new Exchange('a', { apiKey: 'k', secret: 's' }, { client: ca });
  const b = new Exchange('b', { apiKey: 'k', secret: 's' }, { client: cb });
  await a.init();
  await b.init();
  assert.deepEqual(a.perpSymbols(), ['PEPE/USDT:USDT']);
  assert.equal(a.unitSize('PEPE/USDT:USDT'), 1000);
  const ra = await a.fetchFundingRates();
  assert.ok(Math.abs(ra['PEPE/USDT:USDT'].mark - 0.00001) < 1e-15, 'ціна за 1 PEPE');

  const tcfg = { mode: 'live', quote: 'USDT', sizeMode: 'coins', coinQty: { PEPE: 5000000 }, paused: false, leverage: 3, maxPositions: 3,
    timezone: 'Europe/Kyiv', minFunding: 0.001, minProfit: 0, entryBeforeSec: 120, entryMinSec: 20, maxWindowHours: 8, allowEstimated: true,
    maxEntryBasisPct: 0.0015, maxSlippagePct: 0.001, maxAbsFundingRate: 0.1, exitAfterSec: 120, settleDelaySec: 10, convergePct: 0.0005,
    earlyExit: true, liqBufferPct: 0.15, whitelist: [], blacklist: [], defaultTakerFee: 0.0005, coinPriceTol: 0.03 };
  const trader = new Trader(tcfg, { a, b }, new State(null), async () => {});
  trader.now = () => T0;
  const rates = { a: ra, b: await b.fetchFundingRates() };
  const [w] = dueWindows(planWindows(rates, tcfg, undefined, T0), tcfg, T0);
  assert.ok(w, 'пара PEPE знайдена між 1000PEPE і PEPE');
  assert.ok(await trader.tryOpen(w));
  // 5 000 000 PEPE = 5000 контрактів 1000PEPE на a і 5000 контрактів по 1000 PEPE на b
  assert.deepEqual(ca.orders.map((o) => [o.s, o.side, o.amount]), [['1000PEPE/USDT:USDT', 'sell', 5000]]);
  assert.deepEqual(cb.orders.map((o) => [o.s, o.side, o.amount]), [['PEPE/USDT:USDT', 'buy', 5000]]);
  assert.ok(Math.abs(trader.state.positions[0].short.entry - 0.00001) < 1e-12, 'ціна входу за 1 PEPE');
});
