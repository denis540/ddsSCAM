'use strict';
const { Exchange } = require('../src/exchange');

/** Фейковий ccxt-клієнт: один ринок, керований стакан і фандінг. */
function fakeClient({ contractSize = 1, step = 0.001, price = 100, rate = 0.0001, interval = '8h', taker = 0.0005 } = {}) {
  const sym = 'ETH/USDT:USDT';
  const c = {
    orders: [],
    price,
    rate,
    has: { fetchFundingRates: true, setLeverage: true, fetchPositions: true },
    markets: {
      [sym]: { symbol: sym, swap: true, linear: true, settle: 'USDT', quote: 'USDT', contractSize, taker,
        limits: { amount: { min: step }, cost: { min: 5 } } },
    },
    async loadMarkets() { return this.markets; },
    market(s) { return this.markets[s]; },
    amountToPrecision(s, a) { return String(Math.floor(a / step + 1e-9) * step); },
    async fetchFundingRates() {
      return { [sym]: { symbol: sym, fundingRate: this.rate, interval, markPrice: this.price, nextFundingTimestamp: this.next } };
    },
    async fetchOrderBook() {
      const p = this.price;
      return { bids: [[p * 0.9999, 1e6]], asks: [[p * 1.0001, 1e6]] };
    },
    async createOrder(s, type, side, amount, _p, params) {
      if (this.fail) throw new Error('rejected');
      this.orders.push({ s, side, amount, params });
      return { id: String(this.orders.length), filled: amount, average: this.price };
    },
    async setLeverage() {},
    async fetchBalance() { return { free: { USDT: 1000 } }; },
    async fetchPositions() { return []; },
  };
  return c;
}

async function makeExchange(id, opts) {
  const client = fakeClient(opts);
  const ex = new Exchange(id, {}, { client });
  await ex.init();
  return ex;
}

module.exports = { fakeClient, makeExchange };
