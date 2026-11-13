'use strict';

const ccxt = require('ccxt');
const log = require('./logger');

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
  // 4) з різниці попереднього/наступного часу виплати
  if (fr.fundingTimestamp && fr.nextFundingTimestamp && fr.nextFundingTimestamp > fr.fundingTimestamp) {
    const h = Math.round((fr.nextFundingTimestamp - fr.fundingTimestamp) / HOUR);
    if (h >= 1 && h <= 24) return h;
  }
  return 8;
}

/**
 * Обгортка над ccxt-біржею: лише USDT-M перпетуали, уніфіковані методи для бота.
 */
class Exchange {
  constructor(id, credentials = {}, { quote = 'USDT', defaultTakerFee = 0.0005, client } = {}) {
    this.id = id;
    this.quote = quote;
    this.defaultTakerFee = defaultTakerFee;
    if (client) {
      this.client = client; // для тестів
    } else {
      if (!ccxt[id]) throw new Error(`ccxt не підтримує біржу ${id}`);
      this.client = new ccxt[id]({
        ...credentials,
        enableRateLimit: true,
        options: { defaultType: 'swap' },
      });
    }
    this.intervals = {};
    this.leverageSet = new Set();
  }

  async init() {
    await this.client.loadMarkets();
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
    const n = this.perpSymbols().length;
    log.info(`${this.id}: завантажено ${n} перпетуалів ${this.quote}`);
  }

  perpSymbols() {
    return Object.values(this.client.markets)
      .filter((m) => m.swap && m.linear && m.active !== false && m.settle === this.quote && m.quote === this.quote)
      .map((m) => m.symbol);
  }

  market(symbol) {
    return this.client.market(symbol);
  }

  takerFee(symbol) {
    const m = this.client.markets[symbol];
    return (m && Number.isFinite(m.taker) ? m.taker : this.defaultTakerFee);
  }

  /** @returns {Promise<Object<string,{rate:number,intervalH:number,nextTs:number|undefined,mark:number|undefined}>>} */
  async fetchFundingRates() {
    const symbols = this.perpSymbols();
    let raw;
    if (this.client.has.fetchFundingRates) {
      try {
        raw = await this.client.fetchFundingRates();
      } catch (e) {
        if (!(e instanceof ccxt.ArgumentsRequired)) throw e;
        raw = await this.client.fetchFundingRates(symbols); // деяким біржам потрібен явний список
      }
    } else {
      // повільний фолбек — по одному символу
      raw = {};
      for (const s of symbols) {
        try {
          raw[s] = await this.client.fetchFundingRate(s);
        } catch (e) {
          log.debug(`${this.id} ${s}: ${e.message}`);
        }
      }
    }
    const allowed = new Set(symbols);
    const out = {};
    for (const [sym, fr] of Object.entries(raw)) {
      const s = fr.symbol || sym;
      if (!allowed.has(s)) continue;
      const n = this.normalizeRate(fr, s);
      if (n) out[s] = n;
    }
    return out;
  }

  normalizeRate(fr, symbol) {
    if (!fr || !Number.isFinite(fr.fundingRate)) return undefined;
    return {
      rate: fr.fundingRate,
      intervalH: parseIntervalHours({ ...fr, symbol }, this.intervals),
      // У ccxt fundingTimestamp — час НАЙБЛИЖЧОЇ виплати, nextFundingTimestamp — наступної за нею (OKX)
      nextTs: fr.fundingTimestamp || fr.nextFundingTimestamp,
      mark: fr.markPrice || fr.indexPrice,
    };
  }

  /** Свіжа ставка по одному символу (перед самим входом). */
  async fetchFundingRate(symbol) {
    if (this.client.has.fetchFundingRate) return this.normalizeRate(await this.client.fetchFundingRate(symbol), symbol);
    const all = await this.client.fetchFundingRates([symbol]);
    return this.normalizeRate(all[symbol], symbol);
  }

  /** Фактично отриманий (+) / сплачений (−) фандінг з біржі з моменту since. undefined — якщо біржа не віддала. */
  async fetchFundingPaid(symbol, since) {
    if (!this.client.has.fetchFundingHistory) return undefined;
    const rows = await this.client.fetchFundingHistory(symbol, since);
    if (!rows || !rows.length) return undefined;
    return rows.filter((r) => (!r.symbol || r.symbol === symbol) && r.timestamp >= since).reduce((a, r) => a + (r.amount || 0), 0);
  }

  async fetchOrderBook(symbol, limit = 20) {
    return this.client.fetchOrderBook(symbol, limit);
  }

  /** Кількість базової монети -> кількість контрактів (з округленням вниз до кроку біржі). */
  baseToContracts(symbol, baseAmount) {
    const m = this.market(symbol);
    const cs = m.contractSize || 1;
    const contracts = Number(this.client.amountToPrecision(symbol, baseAmount / cs));
    return contracts;
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
    const key = `${symbol}|${leverage}|${marginMode}`; // при зміні плеча/режиму налаштовуємо заново
    if (this.leverageSet.has(key)) return;
    if (this.client.has.setMarginMode && marginMode) {
      try {
        await this.client.setMarginMode(marginMode, symbol, { leverage });
      } catch (e) {
        log.debug(`${this.id} setMarginMode ${symbol}: ${e.message}`);
      }
    }
    if (this.client.has.setLeverage) {
      try {
        await this.client.setLeverage(leverage, symbol);
      } catch (e) {
        log.debug(`${this.id} setLeverage ${symbol}: ${e.message}`);
      }
    }
    this.leverageSet.add(key);
  }

  async freeBalance() {
    const b = await this.client.fetchBalance({ type: 'swap' });
    return (b.free && b.free[this.quote]) || 0;
  }

  /** Ринковий ордер. side: 'buy' | 'sell'. amount у контрактах. */
  async marketOrder(symbol, side, contracts, { reduceOnly = false } = {}) {
    const params = reduceOnly ? { reduceOnly: true } : {};
    const order = await this.client.createOrder(symbol, 'market', side, contracts, undefined, params);
    // Деякі біржі не повертають filled/average одразу — дотягуємо
    let o = order;
    if ((!Number.isFinite(o.filled) || !o.average) && this.client.has.fetchOrder && o.id) {
      try {
        o = await this.client.fetchOrder(o.id, symbol);
      } catch (e) {
        log.debug(`${this.id} fetchOrder: ${e.message}`);
      }
    }
    return {
      id: o.id,
      filled: Number.isFinite(o.filled) && o.filled > 0 ? o.filled : contracts,
      average: o.average || o.price,
      fee: o.fee && o.fee.currency === this.quote ? o.fee.cost : undefined,
    };
  }

  async fetchPosition(symbol) {
    if (!this.client.has.fetchPositions) return undefined;
    const ps = await this.client.fetchPositions([symbol]);
    return ps.find((p) => p.symbol === symbol && Math.abs(p.contracts || 0) > 0);
  }
}

module.exports = { Exchange, parseIntervalHours };
