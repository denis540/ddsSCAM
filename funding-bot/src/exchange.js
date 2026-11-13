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

/** Кількість знаків після коми (для точної арифметики кроків). */
function decimals(x) {
  const t = Number(x).toFixed(15).replace(/0+$/, '');
  const i = t.indexOf('.');
  return i < 0 ? 0 : t.length - i - 1;
}

/**
 * Найменший спільний крок кількості монет для двох бірж (НСК кроків).
 * Напр. 0.001 і 0.1 -> 0.1; 0.3 і 0.2 -> 0.6. Будь-яке кратне — валідна кількість на обох біржах.
 */
function commonStep(a, b) {
  if (!(a > 0)) return b > 0 ? b : undefined;
  if (!(b > 0)) return a;
  const d = Math.max(decimals(a), decimals(b));
  const scale = 10n ** BigInt(d);
  const ia = BigInt(Math.round(a * 10 ** d));
  const ib = BigInt(Math.round(b * 10 ** d));
  const gcd = (x, y) => (y === 0n ? x : gcd(y, x % y));
  const l = (ia / gcd(ia, ib)) * ib;
  return Number(l) / Number(scale);
}

/** Округлення вниз до кроку без хвостів float. */
function floorToStep(x, step) {
  if (!(step > 0)) return x;
  const n = Math.floor(x / step + 1e-9);
  return Number((n * step).toPrecision(12));
}

/** Єдиний вигляд символу в боті: BTC/USDT:USDT (Kraken BTC/USD:USD теж стає BTC/USDT:USDT). */
const canonical = (base) => `${base}/USDT:USDT`;

/**
 * Множник у назві монети: 1000PEPE = 1000 PEPE, 1MBABYDOGE = 1 000 000 BABYDOGE.
 * @returns {{coin:string, mult:number}}
 */
function parseMultiplier(base) {
  const b = String(base);
  let m = b.match(/^(10|100|1000|10000|100000|1000000|10000000|100000000|1000000000)([A-Z][A-Z0-9]*)$/);
  if (m) return { coin: m[2], mult: Number(m[1]) };
  m = b.match(/^1M([A-Z][A-Z0-9]*)$/);
  if (m) return { coin: m[1], mult: 1e6 };
  return { coin: b, mult: 1 };
}

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
      // adjustForTimeDifference — підписи запитів з поправкою на годинник біржі
      this.client = new Cls({ enableRateLimit: true, options: { adjustForTimeDifference: true, ...(this.meta.options || {}) } });
    }
    this.setCredentials(credentials);
    this.intervals = {};
    this.leverageSet = new Set();
    this.native = {}; // канонічний -> символ біржі
    this.fromNative = {}; // символ біржі -> канонічний
    this.mult = {}; // канонічний -> множник (1000 для 1000PEPE)
    this.ready = false;
    this.iocUnsupported = false; // біржа відхилила лімітний IOC — далі лише ринкові
    this.tradeBlocked = undefined; // причина, чому на біржі не можна торгувати (напр. hedge mode)
    this.tickers = {}; // канонічний символ -> { volumeUsdt }
    this.accountFees = {}; // канонічний символ -> { taker, at } — фактичні комісії вашого акаунта
    this.maintenance = undefined; // опис техробіт на біржі, якщо є
    this.selfTest = undefined; // результат останньої самоперевірки
  }

  /** Тестова мережа біржі (SANDBOX=true). @returns {boolean} чи підтримується */
  enableSandbox() {
    if (this.meta.sandbox === false || !(this.client.urls && this.client.urls.test)) return false;
    this.client.setSandboxMode(true);
    return true;
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

  /**
   * Обирає для кожної монети один лінійний перпетуал: пріоритет валюти розрахунку,
   * потім контракт без множника (PEPE краще за 1000PEPE).
   */
  buildSymbolMap() {
    const settles = this.meta.settles || [this.quote];
    const chosen = {};
    for (const m of Object.values(this.client.markets)) {
      if (!m.swap || !m.linear || m.active === false) continue;
      const rank = settles.indexOf(m.settle);
      if (rank < 0 || m.quote !== m.settle) continue;
      const { coin, mult } = parseMultiplier(m.base);
      const prev = chosen[coin];
      if (!prev || rank < prev.rank || (rank === prev.rank && mult < prev.mult)) chosen[coin] = { symbol: m.symbol, rank, mult, base: m.base };
    }
    this.native = {};
    this.fromNative = {};
    this.mult = {};
    this.marketBase = {};
    for (const [coin, { symbol, mult, base }] of Object.entries(chosen)) {
      const c = canonical(coin);
      this.native[c] = symbol;
      this.fromNative[symbol] = c;
      this.mult[c] = mult;
      this.marketBase[c] = base;
    }
  }

  /** Мінімальний крок кількості в МОНЕТАХ (крок лота в контрактах × монет у контракті). */
  amountStep(symbol) {
    const p = this.market(symbol).precision || {};
    if (!(p.amount > 0)) return undefined;
    const tick = this.client.precisionMode === ccxt.DECIMAL_PLACES ? 10 ** -p.amount : p.amount;
    return Number((tick * this.unitSize(symbol)).toPrecision(12));
  }

  /** Максимальне плече для монети, якщо біржа його віддає в даних ринку. */
  maxLeverage(symbol) {
    const m = this.market(symbol);
    const v = m.limits && m.limits.leverage && m.limits.leverage.max;
    return v > 0 ? v : undefined;
  }

  /** Скільки справжніх монет в одному контракті (contractSize × множник). */
  unitSize(symbol) {
    return (this.market(symbol).contractSize || 1) * (this.mult[symbol] || 1);
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

  /** Тейкер-комісія: фактична вашого акаунта (якщо вже завантажена), інакше — базова з даних ринку. */
  takerFee(symbol) {
    const a = this.accountFees[symbol];
    if (a && Number.isFinite(a.taker)) return a.taker;
    const m = this.client.markets[this.n(symbol)];
    return m && Number.isFinite(m.taker) ? m.taker : this.defaultTakerFee;
  }

  /** Усі комісії акаунта одним запитом (де біржа дозволяє). Потрібен API-ключ. */
  async loadAccountFees() {
    if (!this.hasKeys || !this.client.has.fetchTradingFees) return 0;
    const fees = await this.client.fetchTradingFees();
    let n = 0;
    for (const [sym, f] of Object.entries(fees || {})) {
      const c = this.fromNative[f.symbol || sym];
      if (c && Number.isFinite(f.taker)) {
        this.accountFees[c] = { taker: f.taker, at: Date.now() };
        n += 1;
      }
    }
    return n;
  }

  /** Фактична комісія для монети перед входом (кеш на добу). */
  async ensureFee(symbol) {
    if (!this.hasKeys || !this.client.has.fetchTradingFee) return this.takerFee(symbol);
    const a = this.accountFees[symbol];
    if (a && Date.now() - a.at < 86400000) return a.taker;
    try {
      const f = await this.client.fetchTradingFee(this.n(symbol));
      if (f && Number.isFinite(f.taker)) this.accountFees[symbol] = { taker: f.taker, at: Date.now() };
    } catch (e) {
      log.debug(`${this.id} fetchTradingFee ${symbol}: ${e.message}`);
    }
    return this.takerFee(symbol);
  }

  /** Технічні роботи на біржі (fetchStatus). */
  async checkStatus() {
    if (!this.client.has.fetchStatus) return undefined;
    const st = await this.client.fetchStatus();
    const status = String((st && st.status) || '').toLowerCase();
    this.maintenance = status && status !== 'ok' ? `статус біржі «${status}»${st.eta ? `, до ${new Date(st.eta).toISOString().slice(11, 16)} UTC` : ''}` : undefined;
    return this.maintenance;
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
      const r = this.normalizeRate(fr, fr.symbol || sym, Date.now(), this.mult[c]);
      if (r) out[c] = r;
    }
    return out;
  }

  normalizeRate(fr, nativeSymbol, now = Date.now(), mult = 1) {
    if (!fr || !Number.isFinite(fr.fundingRate)) return undefined;
    const intervalH = parseIntervalHours({ ...fr, symbol: nativeSymbol }, this.intervals);
    // У ccxt fundingTimestamp — час НАЙБЛИЖЧОЇ виплати, nextFundingTimestamp — наступної за нею (OKX)
    let nextTs = fr.fundingTimestamp || fr.nextFundingTimestamp;
    if (!nextTs && this.meta.hourAligned) {
      const iv = intervalH * HOUR;
      nextTs = Math.floor(now / iv) * iv + iv; // напр. Kraken: щогодини рівно о :00 UTC
    }
    const mark = fr.markPrice || fr.indexPrice;
    return { rate: fr.fundingRate, intervalH, nextTs, mark: mark ? mark / (mult || 1) : undefined }; // ціна за 1 монету
  }

  /** Свіжа ставка по одному символу (перед самим входом). */
  async fetchFundingRate(symbol) {
    const s = this.n(symbol);
    const mult = this.mult[symbol] || 1;
    if (this.client.has.fetchFundingRate) return this.normalizeRate(await this.client.fetchFundingRate(s), s, Date.now(), mult);
    const all = await this.client.fetchFundingRates([s]);
    return this.normalizeRate(all[s], s, Date.now(), mult);
  }

  /** Фактично отриманий (+) / сплачений (−) фандінг з біржі з моменту since. undefined — якщо біржа не віддала. */
  async fetchFundingPaid(symbol, since) {
    if (!this.client.has.fetchFundingHistory) return undefined;
    const s = this.n(symbol);
    const rows = await this.client.fetchFundingHistory(s, since);
    if (!rows || !rows.length) return undefined;
    return rows.filter((r) => (!r.symbol || r.symbol === s) && r.timestamp >= since).reduce((a, r) => a + (r.amount || 0), 0);
  }

  /** Стакан: ціни — за 1 монету (з урахуванням множника), обсяги — у контрактах. */
  async fetchOrderBook(symbol, limit = this.meta.obLimit === undefined ? 50 : this.meta.obLimit) {
    const ob = await this.client.fetchOrderBook(this.n(symbol), limit ?? undefined);
    const mult = this.mult[symbol] || 1;
    if (mult === 1) return ob;
    const conv = (lv) => lv.map(([p, a]) => [p / mult, a]);
    return { ...ob, bids: conv(ob.bids || []), asks: conv(ob.asks || []) };
  }

  /** Кількість монет -> кількість контрактів (з округленням вниз до кроку біржі). */
  baseToContracts(symbol, baseAmount) {
    return Number(this.client.amountToPrecision(this.n(symbol), baseAmount / this.unitSize(symbol)));
  }

  contractsToBase(symbol, contracts) {
    return Number((contracts * this.unitSize(symbol)).toPrecision(12)); // без хвостів float (33 × 0.1)
  }

  minBaseAmount(symbol, price) {
    const m = this.market(symbol);
    const cs = this.unitSize(symbol);
    const minContracts = (m.limits && m.limits.amount && m.limits.amount.min) || 0;
    const minCost = (m.limits && m.limits.cost && m.limits.cost.min) || 0;
    return Math.max(minContracts * cs, price ? minCost / price : 0);
  }

  /**
   * Режим маржі і плече перед входом. Якщо біржа не прийняла плече — кидає помилку,
   * щоб не відкрити позицію з невідомим плечем.
   */
  async prepareSymbol(symbol, leverage, marginMode) {
    const s = this.n(symbol);
    const key = `${s}|${leverage}|${marginMode}`; // при зміні плеча/режиму налаштовуємо заново
    if (this.leverageSet.has(key)) return;
    this.lastLeverage = leverage;
    this.lastMarginMode = marginMode;
    const benign = (e) => e instanceof ccxt.NoChange || e instanceof ccxt.MarginModeAlreadySet || /not modified|no change|same|already|unchanged|no need/i.test(e.message);
    if (this.client.has.setMarginMode && marginMode) {
      try {
        await this.client.setMarginMode(marginMode, s, { leverage });
      } catch (e) {
        if (!benign(e)) log.warn(`${this.id} setMarginMode ${s}: ${e.message}`);
      }
    }
    if (this.client.has.setLeverage) {
      try {
        await this.client.setLeverage(leverage, s);
      } catch (e) {
        if (!benign(e)) throw new Error(`${this.title}: не вдалося встановити плече x${leverage} для ${symbol.split('/')[0]}: ${e.message}`);
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
      average: (o.average || o.price) ? (o.average || o.price) / (this.mult[symbol] || 1) : undefined,
      fee: o.fee && [settle, this.quote].includes(o.fee.currency) ? o.fee.cost : undefined,
    };
  }

  /** Ціна за 1 монету -> ціна в одиницях ринку біржі (з урахуванням множника), округлена до тіку. */
  nativePrice(symbol, pricePerCoin) {
    const p = pricePerCoin * (this.mult[symbol] || 1);
    return Number(this.client.priceToPrecision(this.n(symbol), p));
  }

  /**
   * Лімітний ордер IOC: виконується одразу в межах ціни (не гірше priceCap за монету), решта скасовується.
   * Захищає від проковзування, якщо стакан змінився між перевіркою і ордером.
   */
  async limitIOC(symbol, side, contracts, priceCap, { reduceOnly = false, leverage, marginMode } = {}) {
    const s = this.n(symbol);
    const params = { timeInForce: 'IOC' };
    if (reduceOnly) params.reduceOnly = true;
    const lev = leverage || this.lastLeverage;
    if (this.meta.openParams && lev) Object.assign(params, this.meta.openParams(lev, marginMode || this.lastMarginMode));
    const price = this.nativePrice(symbol, priceCap);
    const order = await this.client.createOrder(s, 'limit', side, contracts, price, params);
    let o = order;
    if ((!Number.isFinite(o.filled) || (o.filled > 0 && !o.average)) && this.client.has.fetchOrder && o.id) {
      try {
        o = await this.client.fetchOrder(o.id, s);
      } catch (e) {
        log.debug(`${this.id} fetchOrder: ${e.message}`);
      }
    }
    const settle = this.settleOf(symbol);
    const filled = Number.isFinite(o.filled) ? o.filled : 0;
    return {
      id: o.id,
      filled,
      average: filled > 0 && (o.average || o.price) ? (o.average || o.price) / (this.mult[symbol] || 1) : undefined,
      fee: o.fee && [settle, this.quote].includes(o.fee.currency) ? o.fee.cost : undefined,
      type: 'limit',
    };
  }

  /**
   * Захисний стоп на біржі: reduceOnly-ордер, який біржа виконає сама, навіть якщо бот не працює.
   * side — сторона закриття (buy для шорту, sell для лонгу), stopPrice — за 1 монету.
   */
  async placeStop(symbol, side, contracts, stopPrice) {
    const s = this.n(symbol);
    const trig = this.nativePrice(symbol, stopPrice);
    const attempts = [
      { stopLossPrice: trig, reduceOnly: true },
      { triggerPrice: trig, reduceOnly: true, triggerDirection: side === 'buy' ? 'above' : 'below' },
    ];
    let lastErr;
    for (const params of attempts) {
      try {
        const o = await this.client.createOrder(s, 'market', side, contracts, undefined, params);
        return { id: o.id, price: stopPrice };
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr;
  }

  async cancelStop(symbol, id) {
    if (!id) return;
    const s = this.n(symbol);
    for (const params of [{ trigger: true }, {}, { stop: true }]) {
      try {
        await this.client.cancelOrder(id, s, params);
        return;
      } catch (e) {
        if (e instanceof ccxt.OrderNotFound) return;
      }
    }
  }

  /**
   * Перевіряє режим позицій: потрібен one-way. Якщо hedge — пробує перемкнути.
   * @returns {Promise<string|undefined>} опис проблеми, якщо торгувати не можна
   */
  async ensureOneWay() {
    const h = this.client.has;
    if (!this.hasKeys || (!h.fetchPositionMode && !h.setPositionMode)) return undefined;
    try {
      if (h.fetchPositionMode) {
        const m = await this.client.fetchPositionMode();
        if (m && m.hedged === false) return undefined;
      }
      if (h.setPositionMode) {
        try {
          await this.client.setPositionMode(false);
        } catch (e) {
          if (!/not modified|no need|same|already|unchanged/i.test(e.message)) throw e;
        }
        return undefined;
      }
      return 'акаунт у hedge mode — перемкніть на one-way вручну';
    } catch (e) {
      return `не вдалося перевірити/перемкнути режим позицій на one-way: ${e.message.slice(0, 150)}`;
    }
  }

  /** Час сервера біржі мінус локальний час, мс (з урахуванням затримки мережі). */
  async clockOffset() {
    if (!this.client.has.fetchTime) return undefined;
    const t0 = Date.now();
    const server = await this.client.fetchTime();
    const t1 = Date.now();
    return server - (t0 + t1) / 2;
  }

  /** Обсяги торгів за 24 год (USDT) по всіх монетах. */
  async loadTickers() {
    if (!this.client.has.fetchTickers) return;
    const raw = await this.client.fetchTickers();
    const out = {};
    for (const [sym, t] of Object.entries(raw || {})) {
      const c = this.fromNative[t.symbol || sym];
      if (!c) continue;
      let v = t.quoteVolume;
      if (!(v > 0) && t.baseVolume > 0 && t.last > 0) v = t.baseVolume * t.last * (this.market(c).contractSize || 1);
      out[c] = { volumeUsdt: v > 0 ? v : undefined };
    }
    this.tickers = out;
    this.tickersAt = Date.now();
  }

  /**
   * Ризики ринку: щойно лістингована монета, запланований делістинг/експірація, ринок не торгується.
   * @returns {string|undefined} причина не торгувати
   */
  marketRisk(symbol, { newListingDays = 3, delistDays = 14 } = {}, now = Date.now()) {
    const m = this.client.markets[this.n(symbol)];
    if (!m) return 'ринку немає';
    const info = m.info || {};
    const status = String(info.status || info.state || info.contractStatus || '').toLowerCase();
    if (/settl|deliver|delist|close|pause|halt|suspend|pre|pending/.test(status) && !/^(trading|live|normal|open|online|listed)$/.test(status)) {
      return `статус ринку «${status}»`;
    }
    const created = m.created || Number(info.onboardDate) || Number(info.launchTime) || Number(info.listTime) || undefined;
    if (created > 0 && now - created < newListingDays * 86400000) return `нова монета (лістинг ${Math.round((now - created) / 3600000)} год тому)`;
    const dates = [m.expiry, info.deliveryDate, info.deliveryTime, info.expTime, info.offTime, info.delistTime, info.delisting_time, info.expireDate]
      .map(Number)
      .filter((x) => x > now && x < now + 5 * 365 * 86400000);
    const soon = dates.find((d) => d - now < delistDays * 86400000);
    if (soon) return `делістинг/експірація через ${Math.round((soon - now) / 86400000)} дн`;
    return undefined;
  }

  /**
   * Фактична середня ціна, за якою біржа закрила ногу (стоп / ліквідація / вручну), з історії угод.
   * @returns {Promise<number|undefined>} ціна за 1 монету
   */
  async lastClosePrice(symbol, side, since) {
    if (!this.client.has.fetchMyTrades) return undefined;
    const trades = await this.client.fetchMyTrades(this.n(symbol), since);
    const t = (trades || []).filter((x) => x.side === side && x.timestamp >= since);
    const qty = t.reduce((a, x) => a + (x.amount || 0), 0);
    if (!(qty > 0)) return undefined;
    return t.reduce((a, x) => a + x.price * (x.amount || 0), 0) / qty / (this.mult[symbol] || 1);
  }

  /** Історія ставок фандінгу (для перевірки стратегії на історії). */
  async fundingRateHistory(symbol, since, until = Date.now()) {
    if (!this.client.has.fetchFundingRateHistory) return [];
    const s = this.n(symbol);
    const out = [];
    let from = since;
    for (let page = 0; page < 30 && from < until; page++) {
      const rows = await this.client.fetchFundingRateHistory(s, from, 100);
      if (!rows || !rows.length) break;
      for (const r of rows) if (r.timestamp >= since && r.timestamp <= until && Number.isFinite(r.fundingRate)) out.push({ ts: r.timestamp, rate: r.fundingRate });
      const last = rows[rows.length - 1].timestamp;
      if (!(last > from)) break;
      from = last + 1;
      if (rows.length < 100) break;
    }
    const seen = new Set();
    return out.filter((r) => (seen.has(r.ts) ? false : seen.add(r.ts))).sort((a, b) => a.ts - b.ts);
  }

  /**
   * Самоперевірка біржі перед торгівлею (без ризику): баланс, режим позицій, лімітний IOC,
   * що гарантовано не виконається (ціна на 3% гірша за ринок), читання історій.
   * full=true — додатково відкриває мінімальну позицію, ставить і знімає стоп, закриває позицію
   * (коштує лише дві мінімальні комісії).
   * @returns {Promise<{ok:boolean, checks:Array<{name:string, ok:boolean, info:string}>}>}
   */
  async runSelfTest({ full = false, symbol, avoid = [] } = {}) {
    const checks = [];
    const step = async (name, fn, critical = true) => {
      try {
        const info = await fn();
        checks.push({ name, ok: true, info: info || '' });
        return true;
      } catch (e) {
        checks.push({ name, ok: false, critical, info: e.message.slice(0, 160) });
        return false;
      }
    };
    if (!this.hasKeys) return { ok: false, checks: [{ name: 'API-ключ', ok: false, critical: true, info: 'немає ключа' }] };
    // Монета для тесту — БЕЗ відкритих позицій бота на цій біржі: в one-way режимі тестова угода
    // підсумувалась би з бойовою позицією і зіпсувала б хедж.
    const busy = new Set(avoid);
    const prefer = ['BTC/USDT:USDT', 'ETH/USDT:USDT', 'SOL/USDT:USDT', 'XRP/USDT:USDT'];
    const sym = symbol || prefer.concat(this.perpSymbols()).find((s) => this.native[s] && !busy.has(s));
    if (!sym) return { ok: false, checks: [{ name: 'монета для тесту', ok: false, critical: false, info: 'усі монети зайняті позиціями' }] };
    if (full) {
      const p = await this.fetchPosition(sym).catch(() => undefined);
      if (p) return { ok: false, checks: [{ name: 'монета для тесту', ok: false, critical: false, info: `на ${sym.split('/')[0]} вже є позиція — повну перевірку пропущено, щоб її не зачепити` }] };
    }
    await step('баланс', async () => {
      const b = await this.balanceSummary();
      if (!(b.free > 0)) throw new Error(`вільний баланс ${b.free} ${b.currency}`);
      return `${b.free.toFixed(2)} ${b.currency}`;
    });
    await step('режим позицій one-way', async () => {
      const r = await this.ensureOneWay();
      if (r) throw new Error(r);
      return 'ok';
    });
    await step('стакан і ціна', async () => {
      const ob = await this.fetchOrderBook(sym);
      if (!ob.bids[0] || !ob.asks[0]) throw new Error('порожній стакан');
      return `${sym.split('/')[0]} ${ob.bids[0][0]}`;
    });
    await step('лімітний IOC (без виконання)', async () => {
      const ob = await this.fetchOrderBook(sym);
      const price = ob.bids[0][0] * 0.97; // нижче ринку — купівля не виконається
      const minB = Math.max(this.minBaseAmount(sym, price), this.amountStep(sym) || 0);
      const c = Math.max(this.baseToContracts(sym, minB * 1.05), ((this.market(sym).limits || {}).amount || {}).min || 0);
      const o = await this.limitIOC(sym, 'buy', c, price, {});
      if (o.filled > 0) throw new Error(`несподівано виконався на ${o.filled} — закрийте вручну!`);
      return 'біржа приймає IOC';
    }, false);
    await step('історія фандінгу', async () => {
      await this.client.fetchFundingHistory(this.n(sym), Date.now() - 86400000);
      return 'читається';
    }, false);
    await step('історія угод', async () => {
      if (!this.client.has.fetchMyTrades) throw new Error('не підтримується');
      await this.client.fetchMyTrades(this.n(sym), Date.now() - 86400000);
      return 'читається';
    }, false);
    await step('комісії акаунта', async () => `тейкер ${((await this.ensureFee(sym)) * 100).toFixed(4)}%`, false);
    if (full) {
      // Мінімальна реальна позиція: відкрити → стоп → зняти стоп → закрити
      let opened = 0;
      await step('відкриття мінімальної позиції', async () => {
        const ob = await this.fetchOrderBook(sym);
        const price = ob.asks[0][0];
        const minB = Math.max(this.minBaseAmount(sym, price), this.amountStep(sym) || 0);
        const c = Math.max(this.baseToContracts(sym, minB * 1.05), ((this.market(sym).limits || {}).amount || {}).min || 0);
        const o = await this.marketOrder(sym, 'buy', c);
        opened = o.filled;
        return `${this.contractsToBase(sym, opened)} ${sym.split('/')[0]} @ ${o.average}`;
      });
      if (opened > 0) {
        await step('стоп-ордер на біржі', async () => {
          const ob = await this.fetchOrderBook(sym);
          const st = await this.placeStop(sym, 'sell', opened, ob.bids[0][0] * 0.8);
          await this.cancelStop(sym, st.id);
          return 'ставиться і знімається';
        });
        await step('позиція видна на біржі', async () => {
          const p = await this.fetchPosition(sym);
          if (!p) throw new Error('fetchPositions не показує позицію');
          return `${p.contracts} контр., ліквідація ${p.liquidationPrice || '—'}`;
        });
        await step('закриття позиції', async () => {
          await this.marketOrder(sym, 'sell', opened, { reduceOnly: true });
          const p = await this.fetchPosition(sym);
          if (p) throw new Error('позиція лишилась — закрийте вручну!');
          return 'закрито';
        });
      }
    }
    const ok = checks.every((c) => c.ok || !c.critical);
    this.selfTest = { ok, checks, at: Date.now(), full };
    return this.selfTest;
  }

  async fetchPosition(symbol) {
    if (!this.client.has.fetchPositions) return undefined;
    const s = this.n(symbol);
    const ps = await this.client.fetchPositions([s]);
    return ps.find((p) => p.symbol === s && Math.abs(p.contracts || 0) > 0);
  }
}

module.exports = { Exchange, parseIntervalHours, canonical, parseMultiplier, commonStep, floorToStep };
