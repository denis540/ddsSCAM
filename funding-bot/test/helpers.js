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
    priceToPrecision(s, p) { return String(+Number(p).toPrecision(10)); },
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
    pos: {}, // нетто-позиція по символу в контрактах (+ лонг, − шорт)
    stops: [],
    async createOrder(s, type, side, amount, _p, params = {}) {
      if (params.stopLossPrice || params.triggerPrice) {
        if (this.stopFail) throw new Error('stop rejected');
        const id = `stop${this.stops.length + 1}`;
        this.stops.push({ id, s, side, amount, params, active: true });
        return { id };
      }
      if (this.fail) throw new Error('rejected');
      if (type === 'limit' && this.iocError) throw new Error(this.iocError);
      this.orders.push({ s, type, side, amount, params });
      // fillRatio < 1 — біржа виконує ордер частково (лише перший ордер, якщо partialOnce)
      let filled = amount;
      if (type === 'limit' && this.limitFill !== undefined) filled = Math.floor((amount * this.limitFill) / step + 1e-9) * step;
      if (this.fillRatio && (!this.partialOnce || !this.partialDone)) {
        filled = Math.floor((amount * this.fillRatio) / step + 1e-9) * step;
        this.partialDone = true;
      }
      filled = +filled.toFixed(10);
      this.pos[s] = +((this.pos[s] || 0) + (side === 'buy' ? filled : -filled)).toFixed(10);
      return { id: String(this.orders.length), filled, average: this.price };
    },
    async cancelOrder(id) {
      const st = this.stops.find((x) => x.id === id);
      if (st) st.active = false;
      return {};
    },
    async setLeverage(lev) {
      if (this.leverageError) throw new Error(this.leverageError);
      this.leverage = lev;
    },
    async fetchBalance() { return { free: { USDT: 1000 } }; },
    async fetchPositions() {
      return Object.entries(this.pos)
        .filter(([, c]) => c !== 0)
        .map(([symbol, c]) => ({ symbol, contracts: Math.abs(c), side: c > 0 ? 'long' : 'short', markPrice: this.mark ?? this.price, liquidationPrice: this.liq }));
    },
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
