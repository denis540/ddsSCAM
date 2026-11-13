'use strict';

const ccxt = require('ccxt');
const log = require('./logger');
const { metaOf, normalizeName } = require('./exchanges-meta');

const HOUR = 3600 * 1000;

function parseIntervalHours(fr, cachedIntervals) {
  // 1) ccxt уніфіковане поле interval: '8h' | '4h' | '1h'
  if (typeof fr.interval === 'string') {
    const m = fr.interval.match(/^(\d+(?:\.\d+)?)h$/);
    if (m) return Number(m[1]);
  }
  // 2) окремо завантажені інтервали (fetchFundingIntervals)
  const cached = cachedIntervals && cachedIntervals[fr.symbol];
  if (cached) return cached;
  // 3) специфічні поля бірж
  const info = fr.info || {};
  if (info.fundingIntervalHour) return Number(info.fundingIntervalHour);
  if (info.fundingIntervalHours) return Number(info.fundingIntervalHours);
  if (info.funding_interval) return Number(info.funding_interval) / 3600; // gate: секунди
  // 4) з різниці часу найближчої і наступної виплати
  if (fr.fundingTimestamp && fr.nextFundingTimestamp && fr.nextFundingTimestamp > fr.fundingTimestamp) {
    const h = Math.round((fr.nextFundingTimestamp - fr.fundingTimestamp) / HOUR);
    if (h >= 1 && h <= 24) return h;
  }
  return 8;
}

/** Єдиний вигляд символу в боті: BTC/USDT:USDT (Kraken BTC/USD:USD теж стає BTC/USDT:USDT). */
const canonical = (base) => `${base}/USDT:USDT`;

/**
 * Обгортка над ccxt-біржею: лінійні перпетуали, уніфіковані методи для бота.
 * Усі методи приймають канонічний символ і самі перекладають його в символ біржі.
 */
class Exchange {
  constructor(name, credentials = {}, { quote = 'USDT', defaultTakerFee = 0.0005, client } = {}) {
    this.id = normalizeName(name);
    this.meta = metaOf(this.id);
    this.title = this.meta.title || this.id;
    this.quote = quote;
    this.defaultTakerFee = defaultTakerFee;
    if (client) {
      this.client = client; // для тестів
    } else {
      const Cls = ccxt[this.meta.ccxt];
      if (!Cls) throw new Error(`ccxt не підтримує біржу ${this.id}`);
      this.client = new Cls({ enableRateLimit: true, options: { ...(this.meta.options || {}) } });
    }
    this.setCredentials(credentials);
    this.intervals = {};
    this.leverageSet = new Set();
    this.native = {}; // канонічний -> символ біржі
    this.fromNative = {}; // символ біржі -> канонічний
    this.ready = false;
  }

  setCredentials(c = {}) {
    this.client.apiKey = c.apiKey || undefined;
    this.client.secret = c.secret || undefined;
    this.client.password = c.password || undefined;
    this.hasKeys = Boolean(c.apiKey && c.secret);
    if (this.leverageSet) this.leverageSet.clear();
  }

  n(symbol) {
    return this.native[symbol] || symbol;
  }

  async init() {
    await this.client.loadMarkets(true);
    this.buildSymbolMap();
    if (this.client.has.fetchFundingIntervals) {
      try {
        const res = await this.client.fetchFundingIntervals();
        for (const [sym, v] of Object.entries(res || {})) {
          const h = parseIntervalHours({ ...v, symbol: sym });
          if (h) this.intervals[sym] = h;
        }
      } catch (e) {
        log.debug(`${this.id}: fetchFundingIntervals failed: ${e.message}`);
      }
    }
    this.ready = true;
    log.info(`${this.title}: завантажено ${this.perpSymbols().length} перпетуалів${this.hasKeys ? ', API-ключ є' : ', без ключа (лише дані)'}`);
  }

  /** Обирає для кожної монети один лінійний перпетуал (за пріоритетом валюти розрахунку). */
  buildSymbolMap() {
    const settles = this.meta.settles || [this.quote];
    const chosen = {};
    for (const m of Object.values(this.client.markets)) {
      if (!m.swap || !m.linear || m.active === false) continue;
      const rank = settles.indexOf(m.settle);
      if (rank < 0 || m.quote !== m.settle) continue;
      const prev = chosen[m.base];
      if (!prev || rank < prev.rank) chosen[m.base] = { symbol: m.symbol, rank };
    }
    this.native = {};
    this.fromNative = {};
    for (const [base, { symbol }] of Object.entries(chosen)) {
      const c = canonical(base);
      this.native[c] = symbol;
      this.fromNative[symbol] = c;
    }
  }

  perpSymbols() {
    return Object.keys(this.native);
  }

  market(symbol) {
    return this.client.market(this.n(symbol));
  }

  settleOf(symbol) {
    return this.market(symbol).settle || this.quote;
  }

  takerFee(symbol) {
    const m = this.client.markets[this.n(symbol)];
    return m && Number.isFinite(m.taker) ? m.taker : this.defaultTakerFee;
  }

  /** @returns {Promise<Object<string,{rate:number,intervalH:number,nextTs:number|undefined,mark:number|undefined}>>} */
  async fetchFundingRates() {
    const natives = Object.values(this.native);
    let raw;
    if (this.client.has.fetchFundingRates) {
      try {
        raw = await this.client.fetchFundingRates();
      } catch (e) {
        if (!(e instanceof ccxt.ArgumentsRequired)) throw e;
        raw = await this.client.fetchFundingRates(natives); // деяким біржам потрібен явний список
      }
    } else {
      raw = {};
      for (const s of natives) {
        try {
          raw[s] = await this.client.fetchFundingRate(s);
        } catch (e) {
          log.debug(`${this.id} ${s}: ${e.message}`);
        }
      }
    }
    const out = {};
    for (const [sym, fr] of Object.entries(raw)) {
      const c = this.fromNative[fr.symbol || sym];
      if (!c) continue;
      const r = this.normalizeRate(fr, fr.symbol || sym);
      if (r) out[c] = r;
    }
    return out;
  }

  normalizeRate(fr, nativeSymbol, now = Date.now()) {
    if (!fr || !Number.isFinite(fr.fundingRate)) return undefined;
    const intervalH = parseIntervalHours({ ...fr, symbol: nativeSymbol }, this.intervals);
    // У ccxt fundingTimestamp — час НАЙБЛИЖЧОЇ виплати, nextFundingTimestamp — наступної за нею (OKX)
    let nextTs = fr.fundingTimestamp || fr.nextFundingTimestamp;
    if (!nextTs && this.meta.hourAligned) {
      const iv = intervalH * HOUR;
      nextTs = Math.floor(now / iv) * iv + iv; // напр. Kraken: щогодини рівно о :00 UTC
    }
    return { rate: fr.fundingRate, intervalH, nextTs, mark: fr.markPrice || fr.indexPrice };
  }

  /** Свіжа ставка по одному символу (перед самим входом). */
  async fetchFundingRate(symbol) {
    const s = this.n(symbol);
    if (this.client.has.fetchFundingRate) return this.normalizeRate(await this.client.fetchFundingRate(s), s);
    const all = await this.client.fetchFundingRates([s]);
    return this.normalizeRate(all[s], s);
  }

  /** Фактично отриманий (+) / сплачений (−) фандінг з біржі з моменту since. undefined — якщо біржа не віддала. */
  async fetchFundingPaid(symbol, since) {
    if (!this.client.has.fetchFundingHistory) return undefined;
    const s = this.n(symbol);
    const rows = await this.client.fetchFundingHistory(s, since);
    if (!rows || !rows.length) return undefined;
    return rows.filter((r) => (!r.symbol || r.symbol === s) && r.timestamp >= since).reduce((a, r) => a + (r.amount || 0), 0);
  }

  async fetchOrderBook(symbol, limit = 20) {
    return this.client.fetchOrderBook(this.n(symbol), limit);
  }

  /** Кількість базової монети -> кількість контрактів (з округленням вниз до кроку біржі). */
  baseToContracts(symbol, baseAmount) {
    const cs = this.market(symbol).contractSize || 1;
    return Number(this.client.amountToPrecision(this.n(symbol), baseAmount / cs));
  }

  contractsToBase(symbol, contracts) {
    return contracts * (this.market(symbol).contractSize || 1);
  }

  minBaseAmount(symbol, price) {
    const m = this.market(symbol);
    const cs = m.contractSize || 1;
    const minContracts = (m.limits && m.limits.amount && m.limits.amount.min) || 0;
    const minCost = (m.limits && m.limits.cost && m.limits.cost.min) || 0;
    return Math.max(minContracts * cs, price ? minCost / price : 0);
  }

  async prepareSymbol(symbol, leverage, marginMode) {
    const s = this.n(symbol);
    const key = `${s}|${leverage}|${marginMode}`; // при зміні плеча/режиму налаштовуємо заново
    if (this.leverageSet.has(key)) return;
    this.lastLeverage = leverage;
    this.lastMarginMode = marginMode;
    if (this.client.has.setMarginMode && marginMode) {
      try {
        await this.client.setMarginMode(marginMode, s, { leverage });
      } catch (e) {
        log.debug(`${this.id} setMarginMode ${s}: ${e.message}`);
      }
    }
    if (this.client.has.setLeverage) {
      try {
        await this.client.setLeverage(leverage, s);
      } catch (e) {
        log.debug(`${this.id} setLeverage ${s}: ${e.message}`);
      }
    }
    this.leverageSet.add(key);
  }

  async fetchBalanceRaw() {
    return this.client.fetchBalance(this.meta.balanceParams ?? { type: 'swap' });
  }

  /** Вільна маржа для ф'ючерсів (у USDT або USD для Kraken). */
  async freeBalance() {
    const b = await this.fetchBalanceRaw();
    const curr = this.meta.balanceCurrencies || this.meta.settles || [this.quote];
    return curr.reduce((a, c) => a + ((b.free && b.free[c]) || 0), 0);
  }

  async balanceSummary() {
    const b = await this.fetchBalanceRaw();
    const curr = this.meta.balanceCurrencies || this.meta.settles || [this.quote];
    const sum = (k) => curr.reduce((a, c) => a + ((b[k] && b[k][c]) || 0), 0);
    return { free: sum('free'), total: sum('total'), currency: curr.join('+') };
  }

  /** Відкриті позиції на біржі (всі, не лише відкриті ботом). */
  async openPositions() {
    if (!this.client.has.fetchPositions) return [];
    const ps = await this.client.fetchPositions();
    return ps
      .filter((p) => Math.abs(p.contracts || 0) > 0)
      .map((p) => ({ ...p, canonical: this.fromNative[p.symbol] || p.symbol }));
  }

  /** Ринковий ордер. side: 'buy' | 'sell'. amount у контрактах. */
  async marketOrder(symbol, side, contracts, { reduceOnly = false, leverage, marginMode } = {}) {
    const s = this.n(symbol);
    const params = reduceOnly ? { reduceOnly: true } : {};
    const lev = leverage || this.lastLeverage;
    if (this.meta.openParams && lev) Object.assign(params, this.meta.openParams(lev, marginMode || this.lastMarginMode));
    const order = await this.client.createOrder(s, 'market', side, contracts, undefined, params);
    // Деякі біржі не повертають filled/average одразу — дотягуємо
    let o = order;
    if ((!Number.isFinite(o.filled) || !o.average) && this.client.has.fetchOrder && o.id) {
      try {
        o = await this.client.fetchOrder(o.id, s);
      } catch (e) {
        log.debug(`${this.id} fetchOrder: ${e.message}`);
      }
    }
    const settle = this.settleOf(symbol);
    return {
      id: o.id,
      filled: Number.isFinite(o.filled) && o.filled > 0 ? o.filled : contracts,
      average: o.average || o.price,
      fee: o.fee && [settle, this.quote].includes(o.fee.currency) ? o.fee.cost : undefined,
    };
  }

  async fetchPosition(symbol) {
    if (!this.client.has.fetchPositions) return undefined;
    const s = this.n(symbol);
    const ps = await this.client.fetchPositions([s]);
    return ps.find((p) => p.symbol === s && Math.abs(p.contracts || 0) > 0);
  }
}

module.exports = { Exchange, parseIntervalHours, canonical };
