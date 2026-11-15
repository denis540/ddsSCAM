'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Exchange } = require('../src/exchange');
const { KeyStore } = require('../src/keys');
const { normalizeName, SUPPORTED, META } = require('../src/exchanges-meta');
const ccxt = require('ccxt');

test('усі 8 бірж є в ccxt і мають потрібні методи', () => {
  assert.deepEqual(SUPPORTED, ['binance', 'bybit', 'htx', 'okx', 'bitget', 'kucoin', 'bingx', 'kraken']);
  for (const id of SUPPORTED) {
    const ex = new Exchange(id, {});
    assert.ok(ex.client instanceof ccxt[META[id].ccxt], id);
    for (const m of ['fetchFundingRates', 'createOrder', 'fetchPositions', 'fetchFundingHistory']) assert.ok(ex.client.has[m], `${id}.${m}`);
  }
  assert.equal(normalizeName('huobi'), 'htx');
  assert.equal(normalizeName('KuCoinFutures'), 'kucoin');
  assert.equal(normalizeName('krakenfutures'), 'kraken');
});

/** Фейковий Kraken: PF_ USD-перпетуал, без часу виплати. */
function krakenClient() {
  const sym = 'ETH/USD:USD';
  return {
    has: { fetchFundingRates: true },
    markets: {
      [sym]: { symbol: sym, base: 'ETH', quote: 'USD', settle: 'USD', swap: true, linear: true, contractSize: 1, limits: {} },
      'ETH/USD:ETH': { symbol: 'ETH/USD:ETH', base: 'ETH', quote: 'USD', settle: 'ETH', swap: true, linear: false, inverse: true },
    },
    async loadMarkets() { return this.markets; },
    market(s) { return this.markets[s]; },
    amountToPrecision(s, a) { return String(a); },
    async fetchFundingRates() { return { [sym]: { symbol: sym, fundingRate: 0.0004, interval: '1h', markPrice: 3000 } }; },
    async fetchOrderBook(s) { this.lastBook = s; return { bids: [], asks: [] }; },
    async fetchBalance(params) { this.balanceParams = params; return { free: { USD: 100, USDT: 50 }, total: { USD: 120, USDT: 50 } }; },
  };
}

test('Kraken: USD-перпетуал зіставляється з BTC/USDT:USDT, виплата — найближча повна година', async () => {
  const client = krakenClient();
  const ex = new Exchange('kraken', { apiKey: 'k', secret: 's' }, { client });
  await ex.init();
  assert.deepEqual(ex.perpSymbols(), ['ETH/USDT:USDT']); // інверсний контракт відкинуто
  const rates = await ex.fetchFundingRates();
  const r = rates['ETH/USDT:USDT'];
  assert.equal(r.intervalH, 1);
  assert.equal(r.nextTs % 3600000, 0);
  assert.ok(r.nextTs > Date.now() && r.nextTs <= Date.now() + 3600000);
  await ex.fetchOrderBook('ETH/USDT:USDT');
  assert.equal(client.lastBook, 'ETH/USD:USD');
  assert.equal(await ex.freeBalance(), 150); // USD + USDT (мультиколатераль)
  assert.deepEqual(client.balanceParams, {}); // flex-рахунок, без type: swap
});

test('HTX і KuCoin: плече передається в кожному ордері', async () => {
  for (const [id, expect] of [['htx', { leverRate: 5 }], ['kucoin', { leverage: 5, marginMode: 'isolated' }], ['binance', {}]]) {
    const sym = 'ETH/USDT:USDT';
    const client = {
      has: {}, orders: [],
      markets: { [sym]: { symbol: sym, base: 'ETH', quote: 'USDT', settle: 'USDT', swap: true, linear: true, contractSize: 1, limits: {} } },
      async loadMarkets() {}, market(s) { return this.markets[s]; },
      async createOrder(s, t, side, amount, p, params) { this.orders.push(params); return { id: '1', filled: amount, average: 1 }; },
    };
    const ex = new Exchange(id, {}, { client });
    await ex.init();
    await ex.marketOrder(sym, 'buy', 1, { leverage: 5, marginMode: 'isolated' });
    await ex.marketOrder(sym, 'sell', 1, { reduceOnly: true, leverage: 5, marginMode: 'isolated' });
    assert.deepEqual(client.orders[0], expect, id);
    assert.deepEqual(client.orders[1], { reduceOnly: true, ...expect }, id);
  }
});

test('KeyStore: ключі з Telegram мають пріоритет над .env, файл з правами 600', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fb-')), 'keys.json');
  const ks = new KeyStore({ okx: { apiKey: 'envkey', secret: 'x', password: 'p' } }, file);
  assert.equal(ks.get('okx').apiKey, 'envkey');
  assert.equal(ks.source('okx'), '.env');
  ks.set('okx', { apiKey: 'tgkey', secret: 'y', password: 'q' });
  assert.equal(new KeyStore({}, file).get('okx').apiKey, 'tgkey');
  // права 600 — лише Linux/macOS; у Windows доступ визначає обліковий запис (там режим завжди 666)
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  ks.remove('okx');
  assert.equal(ks.get('okx').apiKey, 'envkey');
  assert.equal(ks.source('bybit'), undefined);
});

test('біржі з непідтвердженим масштабом ставок (Kraken) не дають угод, доки не TRUST_RATES', () => {
  const { untrustedRates } = require('../src/exchanges-meta');
  assert.deepEqual(untrustedRates(['binance', 'kraken', 'okx']), ['kraken']);
  assert.deepEqual(untrustedRates(['binance', 'kraken'], ['kraken']), []);
});
