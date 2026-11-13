'use strict';
const { Exchange } = require('../src/exchange');

/** Фейковий ccxt-клієнт: один ринок, керований стакан і фандінг. */
function fakeClient(opts = {}) {
  const { contractSize = 1, step = 0.001, price = 100, rate = 0.0001, interval = '8h', taker = 0.0005 } = opts;
  const sym = 'ETH/USDT:USDT';
  const c = {
    orders: [],
    price,
    rate,
    next: Date.now() + 100000,
    funding: [],
    has: { fetchFundingRates: true, fetchFundingRate: true, fetchFundingHistory: true, setLeverage: true, fetchPositions: true },
    markets: {
      [sym]: { symbol: sym, base: 'ETH', swap: true, linear: true, settle: 'USDT', quote: 'USDT', contractSize, taker,
        precision: { amount: step }, limits: { amount: { min: step }, cost: { min: 5 }, leverage: { max: opts.maxLeverage } } },
    },
    async loadMarkets() { return this.markets; },
    market(s) { return this.markets[s]; },
    amountToPrecision(s, a) { return String(Math.floor(a / step + 1e-9) * step); },
    async fetchFundingRates() {
      return { [sym]: await this.fetchFundingRate(sym) };
    },
    async fetchFundingRate() {
      return { symbol: sym, fundingRate: this.rate, interval, markPrice: this.price, fundingTimestamp: this.next };
    },
    async fetchFundingHistory() { return this.funding; },
    async fetchOrderBook() {
      if (this.book) return JSON.parse(JSON.stringify(this.book));
      const p = this.price;
      return { bids: [[+(p * 0.9999).toFixed(8), 1e6]], asks: [[+(p * 1.0001).toFixed(8), 1e6]] };
    },
    async createOrder(s, type, side, amount, _p, params) {
      if (this.fail) throw new Error('rejected');
      this.orders.push({ s, side, amount, params });
      // fillRatio < 1 — біржа виконує ордер частково (лише перший ордер, якщо partialOnce)
      let filled = amount;
      if (this.fillRatio && (!this.partialOnce || !this.partialDone)) {
        filled = Math.floor((amount * this.fillRatio) / step + 1e-9) * step;
        this.partialDone = true;
      }
      return { id: String(this.orders.length), filled: +filled.toFixed(10), average: this.price };
    },
    async setLeverage(lev) {
      if (this.leverageError) throw new Error(this.leverageError);
      this.leverage = lev;
    },
    async fetchBalance() { return { free: { USDT: 1000 } }; },
    async fetchPositions() { return []; },
  };
  return c;
}

async function makeExchange(id, opts = {}) {
  const client = fakeClient(opts);
  const creds = opts.noKeys ? {} : { apiKey: `${id}-key`, secret: 's' };
  const ex = new Exchange(id, creds, { client });
  await ex.init();
  return ex;
}

module.exports = { fakeClient, makeExchange };
