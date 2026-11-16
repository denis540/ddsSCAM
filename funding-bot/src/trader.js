'use strict';

const log = require('./logger');
const { buildWindow, contrib } = require('./scanner');
const { clock, duration, nowSynced } = require('./time');
const { commonStep, floorToStep } = require('./exchange');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pct = (x, d = 3) => `${(x * 100).toFixed(d)}%`;
const fmt = (x, d = 4) => (Number.isFinite(x) ? (+x.toFixed(d)).toString() : '—');
const sgn = (x, d = 4) => (Number.isFinite(x) ? `${x >= 0 ? '+' : ''}${fmt(x, d)}` : '—');
const coinOf = (symbol) => symbol.split('/')[0];

/** Середня ціна виконання (VWAP) для обсягу baseAmount по стакану. */
function vwap(levels, baseAmount, contractSize = 1) {
  let left = baseAmount;
  let cost = 0;
  for (const [price, amount] of levels) {
    const avail = amount * contractSize;
    const take = Math.min(avail, left);
    cost += take * price;
    left -= take;
    if (left <= 1e-12) break;
  }
  if (left > 1e-9) return undefined; // стакану не вистачає
  return cost / baseAmount;
}

/**
 * Скільки монет можна взяти зі стакану, щоб середня ціна виконання (VWAP) відхилилась
 * від найкращої ціни не більше ніж на maxSlip.
 * @param {Array<[number,number]>} levels  [ціна за монету, обсяг у контрактах]
 * @param {number} unit   монет в одному контракті
 * @param {'buy'|'sell'} side  buy — йдемо по asks (ціна росте), sell — по bids (ціна падає)
 */
function maxDepth(levels, unit, maxSlip, side) {
  if (!levels || !levels.length) return 0;
  const best = levels[0][0];
  const dir = side === 'buy' ? 1 : -1;
  const limit = best * (1 + dir * maxSlip);
  let qty = 0;
  let cost = 0;
  for (const [p, a] of levels) {
    const q = a * unit;
    if (dir * (cost + p * q) <= dir * limit * (qty + q)) {
      qty += q;
      cost += p * q;
      continue;
    }
    // частина рівня: cost + p*x = limit*(qty + x)
    const x = (limit * qty - cost) / (p - limit);
    if (x > 0) qty += x;
    break;
  }
  return qty;
}

class Trader {
  /**
   * @param {object} cfg
   * @param {Object<string, import('./exchange').Exchange>} exchanges
   * @param {import('./state').State} state
   * @param {(t:string)=>Promise<void>} notify
   */
  constructor(cfg, exchanges, state, notify) {
    this.cfg = cfg;
    this.ex = exchanges;
    this.state = state;
    this.notify = notify;
    this.busy = new Set(); // символи, по яких зараз є угода
    this.skipped = new Map(); // вікна, які вже відхилили (щоб не спамити спробами кожен тік)
    this._lock = Promise.resolve();
    this.now = () => nowSynced(); // час з поправкою на годинник бірж
    this.guard = null; // аварійні запобіжники (guard.js)
  }

  async reportError(what) {
    if (this.guard) await this.guard.onError(what);
  }

  /** Сума відкритих позицій (одна нога), USDT; exId — лише на цій біржі. */
  openNotional(exId) {
    let sum = 0;
    for (const p of this.state.positions) {
      if (!exId) sum += p.base * p.long.entry;
      else {
        if (p.shortEx === exId) sum += p.base * p.short.entry;
        if (p.longEx === exId) sum += p.base * p.long.entry;
      }
    }
    return sum;
  }

  /**
   * Ордер з автоматичним вибором типу.
   *  - лімітний IOC з межею ціни cap (не гірше за неї) — для звичайних входів і виходів:
   *    захищає від проковзування, якщо стакан змінився за мить між перевіркою і ордером;
   *  - ринковий — для термінових дій (відкат ноги, вирівнювання, ризик ліквідації, «сирота»),
   *    якщо біржа не приймає IOC або ORDER_TYPE=market.
   */
  async sendOrder(ex, symbol, side, contracts, { cap, urgent = false, reduceOnly = false, leverage, marginMode } = {}) {
    const opts = { reduceOnly, leverage, marginMode };
    const useLimit = !urgent && cap > 0 && this.cfg.orderType !== 'market' && !ex.iocUnsupported;
    if (useLimit) {
      try {
        const o = await ex.limitIOC(symbol, side, contracts, cap, opts);
        return { ...o, type: 'limit' };
      } catch (e) {
        if (/timeinforce|time_in_force|\bioc\b|not support|unsupported|invalid order type|order type/i.test(e.message)) {
          ex.iocUnsupported = true;
          log.warn(`${ex.id}: лімітні IOC не приймаються (${e.message}) — далі ринкові ордери`);
        } else {
          throw e;
        }
      }
    }
    const o = await ex.marketOrder(symbol, side, contracts, opts);
    return { ...o, type: 'market' };
  }

  /** Межа ціни для ордера за поточним стаканом: найкраща ціна ± допустимий слипедж. */
  async priceCap(ex, symbol, side) {
    const ob = await ex.fetchOrderBook(symbol);
    const best = side === 'buy' ? ob.asks[0] && ob.asks[0][0] : ob.bids[0] && ob.bids[0][0];
    if (!best) return undefined;
    return side === 'buy' ? best * (1 + this.cfg.maxSlippagePct) : best * (1 - this.cfg.maxSlippagePct);
  }

  get paper() {
    return this.cfg.mode !== 'live';
  }

  /** Послідовне виконання торгових дій (основний цикл і команди з Telegram не перетинаються). */
  withLock(fn) {
    const run = this._lock.then(fn, fn);
    this._lock = run.catch(() => {});
    return run;
  }

  hasPosition(symbol) {
    return this.state.positions.some((p) => p.symbol === symbol) || this.busy.has(symbol);
  }

  /** Бажаний обсяг входу в монетах: фіксована кількість (coins) або сума USDT / ціна. */
  targetBase(symbol, price) {
    if (this.cfg.sizeMode === 'coins') return this.cfg.coinQty[coinOf(symbol)];
    return this.cfg.positionUsdt / price;
  }

  /** Спільний крок кількості монет для пари бірж: будь-яке кратне — валідна кількість на обох. */
  pairStep(symbol, S, L) {
    return commonStep(S.amountStep(symbol), L.amountStep(symbol));
  }

  /**
   * Однакова кількість монет на обох біржах: округлюємо вниз до спільного кроку лотів
   * і перевіряємо, що обидві біржі дають рівно цю кількість.
   */
  sizePair(symbol, S, L, price, target) {
    if (!(target > 0)) return { error: this.cfg.sizeMode === 'coins' ? 'не задано кількість монет (/qty)' : 'розрахований розмір угоди — 0' };
    const step = this.pairStep(symbol, S, L);
    const base = step ? floorToStep(target, step) : Math.min(S.contractsToBase(symbol, S.baseToContracts(symbol, target)), L.contractsToBase(symbol, L.baseToContracts(symbol, target)));
    if (!(base > 0)) return { error: `кількість ${fmt(target, 8)} менша за спільний крок лота обох бірж (${fmt(step, 8)})` };
    const cS = S.baseToContracts(symbol, base);
    const cL = L.baseToContracts(symbol, base);
    const bS = S.contractsToBase(symbol, cS);
    const bL = L.contractsToBase(symbol, cL);
    if (Math.abs(bS - base) > base * 1e-9 || Math.abs(bL - base) > base * 1e-9) {
      return { error: `не вдалося підібрати однакову кількість на обох біржах (${fmt(bS, 8)} vs ${fmt(bL, 8)})` };
    }
    const minB = Math.max(S.minBaseAmount(symbol, price), L.minBaseAmount(symbol, price));
    if (base < minB) return { error: `менше мінімального ордера (${fmt(minB, 8)})` };
    // У режимі монет заходимо рівно тією кількістю, яку задали
    if (this.cfg.sizeMode === 'coins' && (target - base) / target > 1e-9) {
      return { error: `кількість ${target} не кратна спільному кроку лотів обох бірж (${fmt(step, 8)}), найближче — ${fmt(base, 8)}` };
    }
    return { base, cS, cL, step };
  }

  /** Плече, однакове на обох біржах: ваше, але не більше максимуму кожної біржі для цієї монети. */
  effectiveLeverage(symbol, S, L) {
    const caps = [this.cfg.leverage, S.maxLeverage(symbol), L.maxLeverage(symbol)].filter((x) => x > 0);
    return Math.max(1, Math.floor(Math.min(...caps)));
  }

  orderLine(side, exId, symbol, base, contracts, price, fee, type) {
    const cs = this.ex[exId].unitSize(symbol);
    const contractsTxt = cs !== 1 ? ` (${fmt(contracts, 6)} контр.)` : '';
    const typeTxt = type === 'limit' ? ' [ліміт IOC]' : type === 'market' ? ' [ринок]' : type === 'mixed' ? ' [ліміт IOC + ринок]' : '';
    return (
      `${side === 'sell' ? '🔴 SELL' : '🟢 BUY'} ${fmt(base, 8)} ${coinOf(symbol)}${contractsTxt} @ ${fmt(price, 8)} на ${exId}` +
      ` ≈ ${fmt(base * price, 2)} ${this.cfg.quote}, комісія ${fmt(fee, 4)}${typeTxt}`
    );
  }

  eventLine(ev, base, mark) {
    const sideTxt = ev.side === 'short' ? 'SHORT' : 'LONG';
    const c = contrib(ev);
    const usd = mark ? ` ≈ ${sgn(c * base * mark)} ${this.cfg.quote}` : '';
    const left = ev.ts - this.now();
    const when = left > 0 ? `через ${duration(left)}` : 'виплачено';
    return `   ${clock(ev.ts, this.cfg.timezone)} ${ev.ex} ${sideTxt}: ставка ${pct(ev.rate, 4)}${ev.est ? ' (оцінка)' : ''} → ${sgn(c * 100, 4)}%${usd} [${when}]`;
  }

  windowKey(w) {
    return `${w.symbol}|${w.shortEx}|${w.longEx}|${w.startTs}`;
  }

  /**
   * На яку максимальну суму можна зайти в пару прямо зараз.
   * Ліміти (у монетах): стакан на вхід на обох біржах, стакан на вихід (поточний), вільна маржа (live),
   * ваш максимум на угоду (maxTradeUsdt) і кількість монети з /qty (якщо задана).
   * У режимі auto додатково зменшує розмір, поки чистий профіт з урахуванням слипеджу ≥ minProfit.
   * @returns {Promise<{base:number, mid:number, limits:Object<string,number>, limitedBy:string, books:object}|{error:string}>}
   */
  async estimateCapacity(win, funding = win.funding) {
    const { symbol, shortEx, longEx } = win;
    const S = this.ex[shortEx];
    const L = this.ex[longEx];
    const cfg = this.cfg;
    const [obS, obL] = await Promise.all([S.fetchOrderBook(symbol), L.fetchOrderBook(symbol)]);
    const bidS = obS.bids[0] && obS.bids[0][0];
    const askL = obL.asks[0] && obL.asks[0][0];
    if (!bidS || !askL) return { error: 'порожній стакан' };
    const mid = (bidS + askL) / 2;
    const uS = S.unitSize(symbol);
    const uL = L.unitSize(symbol);
    const slip = cfg.maxSlippagePct;

    const leverage = this.effectiveLeverage(symbol, S, L);
    const limits = {};
    limits[`стакан ${shortEx} (вхід)`] = maxDepth(obS.bids, uS, slip, 'sell');
    limits[`стакан ${longEx} (вхід)`] = maxDepth(obL.asks, uL, slip, 'buy');
    if (cfg.checkExitDepth !== false) {
      limits[`стакан ${shortEx} (вихід)`] = maxDepth(obS.asks, uS, slip, 'buy');
      limits[`стакан ${longEx} (вихід)`] = maxDepth(obL.bids, uL, slip, 'sell');
    }
    if (!this.paper) {
      const [fS, fL] = await Promise.all([S.freeBalance(), L.freeBalance()]);
      // вільний баланс × плече; резерв (reservePct) бот ніколи не використовує
      const use = 1 - (cfg.reservePct ?? 0.15);
      limits[`баланс ${shortEx} ×${leverage}`] = (fS * leverage * use) / mid;
      limits[`баланс ${longEx} ×${leverage}`] = (fL * leverage * use) / mid;
    }
    if (cfg.maxTotalUsdt > 0) limits['загальний ліміт позицій'] = Math.max(0, cfg.maxTotalUsdt - this.openNotional()) / mid;
    if (cfg.maxExchangeUsdt > 0) {
      limits[`ліміт біржі ${shortEx}`] = Math.max(0, cfg.maxExchangeUsdt - this.openNotional(shortEx)) / mid;
      limits[`ліміт біржі ${longEx}`] = Math.max(0, cfg.maxExchangeUsdt - this.openNotional(longEx)) / mid;
    }
    const coinCap = cfg.coinQty[coinOf(symbol)];
    if (cfg.sizeMode === 'auto') {
      // ваша сума — це маржа на кожній біржі; позиція = сума × плече
      limits[`ваша сума ${cfg.maxTradeUsdt}×${leverage}`] = (cfg.maxTradeUsdt * leverage) / mid;
      if (coinCap > 0) limits[`ваш максимум ${coinOf(symbol)}`] = coinCap;
    }

    let limitedBy = '';
    let base = Infinity;
    for (const [k, v] of Object.entries(limits)) {
      if (v < base) {
        base = v;
        limitedBy = k;
      }
    }

    if (cfg.sizeMode === 'auto' && funding !== undefined) {
      // Чим більше обсяг — тим гірші ціни. Шукаємо найбільший обсяг, де різниця цін ще в межах
      // maxEntryBasisPct і чистий профіт ≥ minProfit.
      const fees = 2 * (S.takerFee(symbol) + L.takerFee(symbol));
      const okAt = (b) => {
        const pS = vwap(obS.bids, b, uS);
        const pL = vwap(obL.asks, b, uL);
        if (!pS || !pL) return false;
        const basis = (pS - pL) / pL;
        return basis >= -cfg.maxEntryBasisPct && funding - fees + Math.min(basis, 0) >= cfg.minProfit;
      };
      if (base > 0 && !okAt(base)) {
        let lo = 0;
        let hi = base;
        for (let i = 0; i < 40; i++) {
          const m = (lo + hi) / 2;
          if (okAt(m)) lo = m;
          else hi = m;
        }
        base = lo;
        limitedBy = 'ціна/прибутковість (чим більше обсяг, тим гірша ціна)';
      }
    }
    // Якщо зайти не можна навіть на мінімальний обсяг — чому саме (для журналу і повідомлень)
    let zeroReason;
    {
      const fees = 2 * (S.takerFee(symbol) + L.takerFee(symbol));
      const basis0 = (bidS - askL) / askL; // найкращі ціни: продаємо на S по bid, купуємо на L по ask
      const net0 = funding !== undefined ? funding - fees + Math.min(basis0, 0) : undefined;
      if (basis0 < -cfg.maxEntryBasisPct) {
        zeroReason = `ціна на ${shortEx} (${fmt(bidS, 8)}) нижча, ніж на ${longEx} (${fmt(askL, 8)}), на ${pct(-basis0)} — допуск різниці цін проти нас ${pct(cfg.maxEntryBasisPct)}`;
      } else if (net0 !== undefined && net0 < cfg.minProfit) {
        zeroReason = `чистий прибуток навіть на мінімальному обсязі ${pct(net0)} (фандінг ${pct(funding)} − комісії ${pct(fees)}${basis0 < 0 ? ` − різниця цін ${pct(-basis0)}` : ''}) < порогу ${pct(cfg.minProfit)}`;
      }
    }
    // Однакова кількість на обох біржах — кратна спільному кроку лотів
    const step = this.pairStep(symbol, S, L);
    const exact = Number.isFinite(base) ? (step ? floorToStep(base, step) : base) : 0;
    if (!(exact > 0) && !zeroReason) zeroReason = Number.isFinite(base) && step && base < step ? `обсяг ${fmt(base, 8)} менший за спільний крок лота ${fmt(step, 8)}` : `обмежує: ${limitedBy}`;
    return { base: exact, raw: base, step, leverage, mid, limits, limitedBy, zeroReason: exact > 0 ? undefined : zeroReason, books: { obS, obL } };
  }

  capacityText(cap) {
    const q = this.cfg.quote;
    const parts = Object.entries(cap.limits).map(([k, v]) => `${k} ${fmt(v * cap.mid, 0)}`);
    return `ліміти позиції, ${q}: ${parts.join(' | ')}\nобмежує: ${cap.limitedBy}`;
  }

  /** Вхід у вікно фандінгу (викликається за ~entryBeforeSec до першої виплати). */
  async tryOpen(win) {
    const { symbol, shortEx, longEx } = win;
    const now = this.now();
    if (this.cfg.paused) return false;
    if (this.hasPosition(symbol)) return false;
    if (this.state.positions.length >= this.cfg.maxPositions) return false;
    const key = this.windowKey(win);
    if (this.skipped.has(key)) return false;
    const S = this.ex[shortEx];
    const L = this.ex[longEx];
    if (!S || !L) return false;
    if (!this.paper && (!S.hasKeys || !L.hasKeys)) return false; // торгуємо лише там, де додано API-ключі
    if (!this.paper && (S.tradeBlocked || L.tradeBlocked)) return false; // hedge mode, самоперевірка, розбіжність фандінгу
    if (S.maintenance || L.maintenance) return false; // техроботи на біржі — можна не закрити позицію
    this.busy.add(symbol);
    log.info(`${symbol} SHORT ${shortEx}/LONG ${longEx}: до виплати ${duration(win.startTs - now)} — перевіряю вхід (ставки, стакани, розмір)`);
    const skip = (why) => {
      this.skipped.set(key, win.startTs);
      log.info(`${symbol} ${shortEx}/${longEx} (виплата ${clock(win.startTs, this.cfg.timezone)}): пропуск — ${why}`);
      return false;
    };
    try {
      // 1) Свіжі ставки прямо перед входом — прогнозна ставка може змінитися аж до виплати
      const [rS, rL] = await Promise.all([S.fetchFundingRate(symbol), L.fetchFundingRate(symbol)]);
      // фактичні комісії вашого акаунта (VIP-рівень, знижки), а не базові
      // (і в paper, якщо є ключі: інакше paper-тест показує кращий результат, ніж буде в live)
      await Promise.all([S.ensureFee(symbol), L.ensureFee(symbol)]);
      const fees = 2 * (S.takerFee(symbol) + L.takerFee(symbol));
      const fresh = rS && rL && buildWindow({ symbol, shortEx, longEx, s: rS, l: rL, startTs: win.startTs, endTs: win.endTs, now, cfg: this.cfg, fees });
      if (!fresh) return skip('час виплати змінився');
      if (fresh.funding < this.cfg.minFunding) return skip(`фандінг впав до ${pct(fresh.funding)}`);

      // 2) Стакани: на яку суму можна зайти на обох біржах, слипедж, різниця цін
      const cap = await this.estimateCapacity(win, fresh.funding);
      if (cap.error) return skip(cap.error);
      const { obS, obL } = cap.books;
      const { mid } = cap;
      const bidS = obS.bids[0][0];
      const askL = obL.asks[0][0];
      const auto = this.cfg.sizeMode === 'auto';
      if (auto && !(cap.base > 0)) return skip(`зайти не можна навіть на мінімальну суму — ${cap.zeroReason}`);
      const target = auto ? cap.base : this.targetBase(symbol, mid);
      if (!auto && target > cap.base * 1.0001) {
        return skip(`стакан/маржа не витримає ${fmt(target * mid, 0)} ${this.cfg.quote}: можна до ~${fmt(cap.base * mid, 0)} (обмежує ${cap.limitedBy})`);
      }
      const sizing = this.sizePair(symbol, S, L, mid, target);
      if (sizing.error) return skip(sizing.error);
      if (sizing.base * mid < (this.cfg.minTradeUsdt || 0)) {
        return skip(`замало ліквідності: можна лише ~${fmt(sizing.base * mid, 2)} ${this.cfg.quote} < мінімуму ${this.cfg.minTradeUsdt} (обмежує ${cap.limitedBy})`);
      }
      const pxS = vwap(obS.bids, sizing.base, S.unitSize(symbol));
      const pxL = vwap(obL.asks, sizing.base, L.unitSize(symbol));
      if (!pxS || !pxL) return skip('не вистачає ліквідності');
      const tol = 1 + 1e-9;
      if ((bidS - pxS) / bidS > this.cfg.maxSlippagePct * tol || (pxL - askL) / askL > this.cfg.maxSlippagePct * tol) return skip('слипедж більший за ліміт');
      if (this.coins) {
        const chk = this.coins.check(coinOf(symbol), shortEx, longEx, pxS, pxL);
        if (!chk.ok) return skip(`монета: ${chk.reason}`);
      } else if (Math.abs(pxS - pxL) / Math.min(pxS, pxL) > (this.cfg.coinPriceTol ?? 0.03)) {
        return skip('ціни надто різні — схоже, різні монети');
      }
      const basis = (pxS - pxL) / pxL; // >0: шортимо дорожче, ніж купуємо
      if (basis < -this.cfg.maxEntryBasisPct) return skip(`несприятлива різниця цін ${pct(basis)}`);
      const net = fresh.funding - fees + Math.min(basis, 0);
      if (net < this.cfg.minProfit) return skip(`чистий профіт ${pct(net)} < ${pct(this.cfg.minProfit)}`);

      const { leverage } = cap; // однакове на обох біржах
      if (!this.paper) {
        // маржу вже враховано в estimateCapacity; якщо біржа не прийняла плече — не заходимо
        try {
          await Promise.all([
            S.prepareSymbol(symbol, leverage, this.cfg.marginMode),
            L.prepareSymbol(symbol, leverage, this.cfg.marginMode),
          ]);
        } catch (e) {
          return skip(e.message);
        }
      }
      if (!this.paper) {
        // В one-way режимі позиції по монеті сумуються: якщо на біржі вже є позиція (ручна чи чужа),
        // наша угода змішалась би з нею. Такий вхід пропускаємо.
        const pre = await Promise.all([S.fetchPosition(symbol), L.fetchPosition(symbol)]);
        if (pre[0] || pre[1]) return skip(`на ${pre[0] ? shortEx : longEx} вже є позиція по ${coinOf(symbol)} (не від цієї угоди)`);
      }
      if (this.now() > win.startTs - this.cfg.entryMinSec * 1000) return skip('не встигли до виплати');

      // 3) Відкриття обох ніг. Намір записуємо ДО ордерів: якщо бот впаде посередині,
      //    звірка після перезапуску знайде і закриє непарну ногу.
      const slip = this.cfg.maxSlippagePct;
      const caps = { capS: bidS * (1 - slip), capL: askL * (1 + slip) };
      this.state.setPending({ symbol, shortEx, longEx, ts: this.now() });
      let legs;
      try {
        legs = await this.executeOpen(symbol, S, L, sizing, pxS, pxL, leverage, caps);
      } catch (e) {
        // Намір НЕ стираємо: звірка з біржами знайде й закриє ноги, що встигли відкритись
        this.skipped.set(key, win.startTs);
        await this.notify(`🚨 ${symbol}: збій посеред відкриття (${e.message}). Звірка з біржами перевірить і закриє непарні ноги.`);
        await this.reportError(`${symbol}: збій посеред відкриття`);
        if (this.onCrashDuringOpen) this.onCrashDuringOpen();
        return false;
      }
      this.state.clearPending(symbol);
      if (!legs) return skip('не вдалося відкрити');

      const openedAt = this.now();
      const pos = {
        id: `${symbol}|${shortEx}|${longEx}|${openedAt}`,
        symbol,
        shortEx,
        longEx,
        base: legs.base,
        leverage,
        short: { contracts: legs.short.filled, entry: legs.short.average },
        long: { contracts: legs.long.filled, entry: legs.long.average },
        openedAt,
        convergeWaitNotified: false,
        expectedEntry: { short: pxS, long: pxL },
        startTs: fresh.startTs,
        endTs: fresh.endTs,
        exitAt: fresh.endTs + this.cfg.exitAfterSec * 1000,
        events: fresh.events.map((e) => ({ ...e, paid: false })),
        expectedFunding: fresh.funding,
        entryBasis: basis,
        fundingAccrued: 0,
        feesPaid: legs.fees,
        paper: this.paper,
        capacity: { usdt: cap.base * mid, limitedBy: cap.limitedBy },
      };
      this.state.addPosition(pos);
      const notional = pos.base * mid;
      await this.notify(
        `✅ ВХІД ${symbol}${this.paper ? ' [PAPER]' : ''} — під фандінг о ${clock(pos.startTs, this.cfg.timezone)}` +
          `${pos.endTs !== pos.startTs ? `–${clock(pos.endTs, this.cfg.timezone)}` : ''}\n` +
          `${this.orderLine('sell', shortEx, symbol, pos.base, pos.short.contracts, pos.short.entry, legs.shortFee, legs.shortType)}\n` +
          `${this.orderLine('buy', longEx, symbol, pos.base, pos.long.contracts, pos.long.entry, legs.longFee, legs.longType)}\n` +
          `Кількість: ${fmt(pos.base, 8)} ${coinOf(symbol)} — однакова на обох біржах (крок ${fmt(cap.step, 8)})\n` +
          `Розмір: ${fmt(notional, 2)} ${this.cfg.quote}, плече x${leverage} на обох → маржа ~${fmt(notional / leverage, 2)} на кожній біржі` +
          `${this.cfg.sizeMode === 'auto' ? '' : ` (режим ${this.cfg.sizeMode})`}\n` +
          `${this.capacityText(cap)}\n` +
          `Виплати у вікні:\n${pos.events.map((e) => this.eventLine(e, pos.base, mid)).join('\n')}\n` +
          `Очікуваний фандінг: ${sgn(fresh.funding * 100, 4)}% ≈ ${sgn(fresh.funding * notional)} ${this.cfg.quote}\n` +
          `Різниця цін на вході: ${pct(basis)}, комісії (вхід+вихід) ≈ ${fmt(fees * notional)}\n` +
          `Чистий очікуваний: ${sgn(net * 100, 3)}% ≈ ${sgn(net * notional)} ${this.cfg.quote}\n` +
          `Вихід: ~${clock(pos.exitAt, this.cfg.timezone)} або раніше, коли ціни зійдуться`
      );
      this.skipped.set(key, win.startTs);
      if (!this.paper && this.cfg.protectStops) await this.placeProtection(pos);
      return true;
    } catch (e) {
      log.error(`${symbol}: помилка відкриття: ${e.message}`);
      return false;
    } finally {
      this.busy.delete(symbol);
      for (const [k, ts] of this.skipped) if (ts < now - 3600000) this.skipped.delete(k);
    }
  }

  async executeOpen(symbol, S, L, sizing, pxS, pxL, leverage = this.cfg.leverage, caps = {}) {
    if (this.paper) {
      const shortFee = sizing.base * pxS * S.takerFee(symbol);
      const longFee = sizing.base * pxL * L.takerFee(symbol);
      const type = this.cfg.orderType === 'market' ? 'market' : 'limit';
      return {
        base: sizing.base,
        short: { filled: sizing.cS, average: pxS },
        long: { filled: sizing.cL, average: pxL },
        shortFee,
        longFee,
        fees: shortFee + longFee,
        shortType: type,
        longType: type,
      };
    }
    // Обидві ноги паралельно — мінімізуємо час, коли позиція не захеджована.
    // Тип ордера бот обирає сам (sendOrder): лімітний IOC з межею ціни або ринковий.
    const opts = { leverage, marginMode: this.cfg.marginMode };
    const [rs, rl] = await Promise.allSettled([
      this.sendOrder(S, symbol, 'sell', sizing.cS, { ...opts, cap: caps.capS }),
      this.sendOrder(L, symbol, 'buy', sizing.cL, { ...opts, cap: caps.capL }),
    ]);
    if (rs.status === 'fulfilled' && rl.status === 'fulfilled') {
      const short = rs.value;
      const long = rl.value;
      // Правда — фактична позиція на біржі, а не відповідь на ордер (деякі біржі звітують із запізненням)
      await this.syncFilledWithPositions(symbol, [[S, short, 'short'], [L, long, 'long']]);
      short.average = short.average || pxS;
      long.average = long.average || pxL;
      const shortFee = short.fee ?? S.contractsToBase(symbol, short.filled) * short.average * S.takerFee(symbol);
      const longFee = long.fee ?? L.contractsToBase(symbol, long.filled) * long.average * L.takerFee(symbol);
      const base = await this.equalizeLegs(symbol, S, L, short, long);
      if (!(base > 0)) {
        const why = short.filled > 0 || long.filled > 0 ? 'після вирівнювання ніг позиції не лишилось' : 'лімітні ордери не виконались у межах ціни (стакан змінився)';
        await this.notify(`ℹ️ ${symbol}: вхід скасовано — ${why}. Збитку немає, крім можливих комісій.`);
        return undefined;
      }
      return { base, short, long, shortFee, longFee, fees: shortFee + longFee, shortType: short.type, longType: long.type };
    }
    // Одна нога не відкрилась — відкатуємо іншу (терміново, ринком)
    await this.syncFilledWithPositions(
      symbol,
      [[S, rs, 'short'], [L, rl, 'long']].filter(([, r]) => r.status === 'fulfilled').map(([ex, r, k]) => [ex, r.value, k])
    );
    const failed = [];
    if (rs.status === 'rejected') failed.push(`SHORT ${S.id}: ${rs.reason && rs.reason.message}`);
    if (rl.status === 'rejected') failed.push(`LONG ${L.id}: ${rl.reason && rl.reason.message}`);
    const rollback = [];
    for (const [r, ex, side] of [[rs, S, 'buy'], [rl, L, 'sell']]) {
      if (r.status !== 'fulfilled' || !(r.value.filled > 0)) continue;
      const o = await this.closeLegWithRetry(ex, symbol, side, r.value.filled, { ...opts, urgent: true });
      if (o) rollback.push(this.orderLine(side, ex.id, symbol, ex.contractsToBase(symbol, o.filled), o.filled, o.average, o.fee, o.type));
    }
    await this.notify(`⚠️ ${symbol}: не вдалося відкрити пару, відкат.\n${failed.join('\n')}${rollback.length ? `\nВідкат:\n${rollback.join('\n')}` : ''}`);
    await this.reportError(`не вдалося відкрити ${symbol}: ${failed.join('; ')}`);
    return undefined;
  }

  /**
   * Звіряє виконану кількість з фактичною позицією на біржі (перед входом позиції по монеті не було,
   * тож позиція = виконане). Якщо біржа не відповіла — лишаємо дані з відповіді на ордер.
   */
  async syncFilledWithPositions(symbol, legs) {
    await new Promise((r) => setTimeout(r, this.positionSyncDelayMs ?? 300));
    await Promise.all(
      legs.map(async ([ex, order, side]) => {
        try {
          const p = await ex.fetchPosition(symbol);
          const actual = p && (!p.side || p.side === side) ? Math.abs(p.contracts) : 0;
          if (Math.abs(actual - (order.filled || 0)) > 1e-12) {
            log.warn(`${ex.id} ${symbol}: ордер звітував ${order.filled}, фактична позиція ${actual} — беру фактичну`);
            order.filled = actual;
          }
        } catch (e) {
          log.debug(`${ex.id} fetchPosition ${symbol}: ${e.message}`);
        }
      })
    );
  }

  /**
   * Біржі могли виконати ордери не повністю. Доводимо обидві ноги до ОДНАКОВОЇ кількості монет:
   * найбільше кратне спільного кроку, що ≤ меншої ноги; зайве закриваємо терміново (ринком).
   * @returns {Promise<number>} кількість монет на кожній нозі
   */
  async equalizeLegs(symbol, S, L, short, long) {
    const bS = S.contractsToBase(symbol, short.filled);
    const bL = L.contractsToBase(symbol, long.filled);
    if (bS === bL) return bS;
    const step = this.pairStep(symbol, S, L);
    const target = step ? floorToStep(Math.min(bS, bL), step) : Math.min(bS, bL);
    const lines = [];
    for (const [ex, side, leg, b] of [[S, 'buy', short, bS], [L, 'sell', long, bL]]) {
      const extra = Number((b - target).toPrecision(12));
      if (extra <= 0) continue;
      const c = ex.baseToContracts(symbol, extra);
      if (!(c > 0)) continue;
      const o = await this.closeLegWithRetry(ex, symbol, side, c, { urgent: true }, 3);
      if (!o) continue;
      leg.filled = Number((leg.filled - o.filled).toPrecision(12));
      lines.push(this.orderLine(side, ex.id, symbol, ex.contractsToBase(symbol, o.filled), o.filled, o.average, o.fee, o.type));
    }
    const fS = S.contractsToBase(symbol, short.filled);
    const fL = L.contractsToBase(symbol, long.filled);
    if (bS > 0 || bL > 0) {
      await this.notify(
        `⚖️ ${symbol}: біржі виконали різну кількість (${fmt(bS, 8)} / ${fmt(bL, 8)}), вирівнюю до ${fmt(target, 8)}\n${lines.join('\n')}` +
          (fS !== fL ? `\n🚨 Ноги досі різні: ${S.id} ${fmt(fS, 8)}, ${L.id} ${fmt(fL, 8)} — перевірте вручну!` : '')
      );
    }
    if (fS !== fL) await this.reportError(`${symbol}: не вдалося вирівняти ноги`);
    return Math.min(fS, fL);
  }

  /**
   * Закриття ноги (reduceOnly) з повторами, доки не закриється вся кількість.
   * Звичайне закриття: до 2 спроб лімітним IOC з межею ціни за свіжим стаканом, далі — ринком
   * (вийти треба гарантовано). Термінове (urgent): одразу ринком.
   * Якщо позиції на біржі вже немає (спрацював стоп, ліквідація) — повертає externallyClosed.
   * @returns {Promise<{filled:number, average:number|undefined, fee:number|undefined, type:string, externallyClosed?:boolean}|undefined>}
   */
  async closeLegWithRetry(exchange, symbol, side, contracts, opts = {}, attempts = 5) {
    let left = contracts;
    let filled = 0;
    let cost = 0;
    let fee;
    const types = new Set();
    let limitTries = opts.urgent ? 0 : 2;
    const total = attempts + limitTries;
    const minLeft = exchange.contractStep ? exchange.contractStep(symbol) * 0.5 : 0;
    let lastErr;
    for (let i = 1; i <= total && left > minLeft; i++) {
      try {
        let cap;
        if (limitTries > 0) {
          limitTries -= 1;
          cap = await this.priceCap(exchange, symbol, side).catch(() => undefined);
        }
        const o = await this.sendOrder(exchange, symbol, side, left, { ...opts, reduceOnly: true, cap, urgent: !cap });
        const f = Math.min(o.filled || 0, left);
        if (f > 0) types.add(o.type);
        filled = Number((filled + f).toPrecision(12));
        cost += f * (o.average || 0);
        if (o.fee !== undefined) fee = (fee || 0) + o.fee;
        left = Number((left - f).toPrecision(12));
        if (left > minLeft && f > 0) log.warn(`${exchange.id} ${symbol}: закрито частково, лишилось ${left} контр. — дозакриваю`);
      } catch (e) {
        lastErr = e;
        log.error(`${exchange.id} ${symbol}: закриття ноги, спроба ${i}/${total}: ${e.message}`);
        if (i < total) await sleep(500 * 2 ** Math.min(i, 3));
      }
    }
    if (left > minLeft) {
      // Можливо, позиції вже немає (біржа закрила стопом/ліквідацією) — тоді reduceOnly і не пройде
      try {
        const p = await exchange.fetchPosition(symbol);
        if (!p) {
          log.warn(`${exchange.id} ${symbol}: позиції на біржі вже немає — нога закрита біржею`);
          return { filled: contracts, average: filled > 0 ? cost / filled : undefined, fee, type: [...types][0], externallyClosed: filled < contracts };
        }
      } catch (e) {
        log.debug(`${exchange.id} fetchPosition: ${e.message}`);
      }
      const key = `${exchange.id}|${symbol}`;
      this.closeFailAt = this.closeFailAt || {};
      if (!this.closeFailAt[key] || this.now() - this.closeFailAt[key] > 5 * 60000) {
        this.closeFailAt[key] = this.now();
        await this.notify(
          `🚨 ${symbol}: НЕ ВДАЛОСЯ ЗАКРИТИ ${filled > 0 ? `залишок ${left} контр. ` : ''}ноги на ${exchange.id}` +
            `${lastErr ? ` (${lastErr.message.slice(0, 150)})` : ''}. Бот повторює спроби; перевірте біржу.`
        );
      }
      await this.reportError(`${symbol}: не вдалося закрити ногу на ${exchange.id}`);
      return undefined;
    }
    const type = types.size > 1 ? 'mixed' : [...types][0];
    return { filled, average: filled > 0 ? cost / filled : undefined, fee, type };
  }

  /** Оцінка ціни ліквідації ноги, якщо біржа її не дала (ізольована маржа ~1/плече). */
  estimateLiq(pos, legKey) {
    const lev = pos.leverage || this.cfg.leverage;
    const e = pos[legKey].entry;
    return legKey === 'short' ? e * (1 + 1 / lev) : e * (1 - 1 / lev);
  }

  /**
   * Захисні стоп-ордери на самих біржах: на stopAtPct шляху від входу до ліквідації кожної ноги.
   * Спрацюють, навіть якщо бот упав або зник інтернет. Бот сам закриває раніше (liqClosePct).
   */
  async placeProtection(pos) {
    const lines = [];
    const legs = [['short', pos.shortEx, 'buy'], ['long', pos.longEx, 'sell']];
    await Promise.all(
      legs.map(async ([legKey, exId, side]) => {
        const ex = this.ex[exId];
        const leg = pos[legKey];
        try {
          let liq;
          try {
            const p = await ex.fetchPosition(pos.symbol);
            if (p && p.liquidationPrice > 0) liq = p.liquidationPrice / (ex.mult[pos.symbol] || 1);
          } catch (e) {
            log.debug(`${exId} fetchPosition: ${e.message}`);
          }
          // ціна ліквідації має бути «по той бік» від входу (шорт — вище, лонг — нижче); інакше — оцінка
          const valid = liq > 0 && (legKey === 'short' ? liq > leg.entry : liq < leg.entry);
          leg.liq = valid ? liq : this.estimateLiq(pos, legKey);
          const stop = leg.entry + (leg.liq - leg.entry) * this.cfg.stopAtPct;
          const o = await ex.placeStop(pos.symbol, side, leg.contracts, stop);
          leg.stopId = o.id;
          leg.stopPrice = stop;
          lines.push(`🛡 ${exId} ${legKey.toUpperCase()}: стоп ${fmt(stop, 8)} (ліквідація ~${fmt(leg.liq, 8)})`);
        } catch (e) {
          lines.push(`⚠️ ${exId} ${legKey.toUpperCase()}: стоп не поставлено — ${e.message.slice(0, 120)}`);
          await this.reportError(`${pos.symbol}: стоп на ${exId} не поставлено`);
        }
      })
    );
    this.state.save();
    await this.notify(`${pos.symbol}: захисні стопи на біржах\n${lines.join('\n')}`);
  }

  async cancelProtection(pos) {
    await Promise.all(
      [['short', pos.shortEx], ['long', pos.longEx]].map(async ([legKey, exId]) => {
        const leg = pos[legKey];
        if (!leg.stopId) return;
        try {
          await this.ex[exId].cancelStop(pos.symbol, leg.stopId);
        } catch (e) {
          log.warn(`${exId}: не вдалося скасувати стоп ${leg.stopId}: ${e.message}`);
        }
        leg.stopId = undefined;
      })
    );
  }

  /**
   * Оновлює прогнозні ставки невиплачених подій і нараховує виплати, що відбулися.
   * Ставка на біржі змінюється аж до моменту виплати, тому до виплати тримаємо найсвіжішу.
   */
  processEvents(pos, ratesByExchange) {
    const now = this.now();
    let changed = false;
    for (const ev of pos.events) {
      if (ev.paid) continue;
      const r = ratesByExchange[ev.ex] && ratesByExchange[ev.ex][pos.symbol];
      if (r && ev.ts > now && r.nextTs && Math.abs(r.nextTs - ev.ts) < 60000) {
        ev.rate = r.rate;
        ev.est = false;
      }
      if (now >= ev.ts + this.cfg.settleDelaySec * 1000) {
        const mark = (r && r.mark) || (ev.side === 'short' ? pos.short.entry : pos.long.entry);
        const payment = contrib(ev) * pos.base * mark;
        ev.paid = true;
        ev.amount = payment;
        pos.fundingAccrued += payment;
        this.state.addDaily('funding', payment, ev.ts);
        log.info(`${pos.symbol} ${ev.side}@${ev.ex}: фандінг ${sgn(payment)} ${this.cfg.quote}`);
        changed = true;
      }
    }
    if (changed) this.state.save();
    return changed;
  }

  /**
   * Live: виплата вважається отриманою, лише коли біржа показала нарахування в історії фандінгу
   * (або минуло fundingConfirmSec — тоді оцінка). Поки не підтверджено — не виходимо (крім ризику ліквідації).
   * Фактичну суму порівнюємо з розрахунком: систематична розбіжність на біржі → торгівлю на ній блокуємо.
   */
  async confirmEvents(pos, ratesByExchange) {
    const now = this.now();
    let changed = false;
    for (const ev of pos.events || []) {
      if (ev.paid) continue;
      const r = ratesByExchange[ev.ex] && ratesByExchange[ev.ex][pos.symbol];
      if (r && ev.ts > now && r.nextTs && Math.abs(r.nextTs - ev.ts) < 60000) {
        ev.rate = r.rate;
        ev.est = false;
      }
      if (now < ev.ts + this.cfg.settleDelaySec * 1000) continue;
      const mark = (r && r.mark) || (ev.side === 'short' ? pos.short.entry : pos.long.entry);
      const expected = contrib(ev) * pos.base * mark;
      if (ev.lastCheck && now - ev.lastCheck < 5000 && now < ev.ts + (this.cfg.fundingConfirmSec ?? 90) * 1000) continue;
      ev.lastCheck = now;
      let actual;
      try {
        actual = await this.ex[ev.ex].fetchFundingPaid(pos.symbol, ev.ts - 60000);
      } catch (e) {
        log.debug(`${ev.ex} fetchFundingHistory: ${e.message}`);
      }
      if (actual !== undefined && actual !== 0) {
        Object.assign(ev, { paid: true, amount: actual, expected, confirmed: true });
        pos.fundingAccrued += actual;
        this.state.addDaily('funding', actual, ev.ts);
        log.info(`${pos.symbol} ${ev.side}@${ev.ex}: фандінг підтверджено біржею ${sgn(actual)} (розрахунок ${sgn(expected)})`);
        await this.checkFundingMatch(ev.ex, expected, actual, pos.symbol);
        changed = true;
      } else if (now >= ev.ts + (this.cfg.fundingConfirmSec ?? 90) * 1000) {
        Object.assign(ev, { paid: true, amount: expected, expected, confirmed: false });
        pos.fundingAccrued += expected;
        this.state.addDaily('funding', expected, ev.ts);
        log.warn(`${pos.symbol} ${ev.ex}: біржа не показала нарахування за ${this.cfg.fundingConfirmSec ?? 90} с — беру розрахунок ${sgn(expected)}`);
        changed = true;
      }
    }
    if (changed) this.state.save();
  }

  /** Розрахунок vs факт по біржі. 2 розбіжності з останніх 5 — біржу блокуємо до ручної перевірки (/unblock). */
  async checkFundingMatch(exId, expected, actual, symbol) {
    if (Math.abs(expected) < 0.01) return;
    const ratio = actual / expected;
    const bad = ratio < 0.5 || ratio > 1.5;
    const fc = (this.state.data.fundingCheck = this.state.data.fundingCheck || {});
    const list = (fc[exId] = (fc[exId] || []).concat({ ts: this.now(), symbol, expected, actual, bad }).slice(-5));
    this.state.save();
    if (!bad) return;
    await this.notify(`⚠️ ${exId} ${symbol.split('/')[0]}: фандінг ${sgn(actual)} замість розрахованих ${sgn(expected)} (×${ratio.toFixed(2)})`);
    const ex = this.ex[exId];
    if (list.filter((x) => x.bad).length >= 2 && ex && !ex.tradeBlocked) {
      ex.tradeBlocked = 'фактичний фандінг систематично не збігається з розрахунком — перевірте біржу, потім /unblock';
      await this.notify(`⛔ ${exId}: торгівлю заблоковано — ${ex.tradeBlocked}`);
    }
  }

  /** Поточна різниця цін для закриття: купуємо назад шорт (ask S), продаємо лонг (bid L). */
  async exitQuote(pos) {
    const S = this.ex[pos.shortEx];
    const L = this.ex[pos.longEx];
    const [obS, obL] = await Promise.all([S.fetchOrderBook(pos.symbol), L.fetchOrderBook(pos.symbol)]);
    const askS = vwap(obS.asks, pos.base, S.unitSize(pos.symbol)) || (obS.asks[0] && obS.asks[0][0]);
    const bidL = vwap(obL.bids, pos.base, L.unitSize(pos.symbol)) || (obL.bids[0] && obL.bids[0][0]);
    if (!askS || !bidL) return undefined;
    const exitBasis = (askS - bidL) / bidL;
    const pricePnl = (pos.short.entry - askS) * pos.base + (bidL - pos.long.entry) * pos.base;
    const closeFees = pos.base * (askS * S.takerFee(pos.symbol) + bidL * L.takerFee(pos.symbol));
    return { askS, bidL, exitBasis, pricePnl, closeFees };
  }

  /**
   * До якого моменту після виплати можна чекати, поки ціни зійдуться: exitAt + maxConvergeWaitMin,
   * але не пізніше ніж за хвилину до наступної виплати на будь-якій з бірж (вона може бути проти нас).
   */
  convergeDeadline(pos, ratesByExchange) {
    const waitMs = (this.cfg.maxConvergeWaitMin || 0) * 60000;
    if (!waitMs) return pos.exitAt;
    let deadline = pos.exitAt + waitMs;
    for (const exId of [pos.shortEx, pos.longEx]) {
      const r = ratesByExchange[exId] && ratesByExchange[exId][pos.symbol];
      const iv = ((r && r.intervalH) || 8) * 3600000;
      const next = r && r.nextTs > pos.endTs + 1000 ? r.nextTs : pos.endTs + iv;
      deadline = Math.min(deadline, next - 60000);
    }
    return Math.max(deadline, pos.exitAt);
  }

  /** Перевірка всіх позицій: нарахування, вихід після виплати / при сходженні цін / ризик. */
  async manage(ratesByExchange) {
    const now = this.now();
    for (const pos of [...this.state.positions]) {
      try {
        if (pos.closeError) {
          // Повтор закриття: швидкий (2 спроби), щоб не блокувати нагляд за іншими позиціями
          await this.closePair(pos, `повторна спроба закриття (${pos.closeError})`, undefined, { urgent: true, retry: true });
          continue;
        }
        // Ризик ліквідації — першим, кожні liqCheckSec (за замовчуванням 5 с)
        const every = (this.cfg.liqCheckSec ?? 5) * 1000;
        if (!pos.lastRiskCheck || now - pos.lastRiskCheck >= every - 500) {
          pos.lastRiskCheck = now;
          const risk = await this.liquidationRisk(pos, ratesByExchange);
          if (risk) {
            await this.closePair(pos, risk.reason, undefined, { urgent: true, missing: risk.missing });
            continue;
          }
        }
        if (this.paper) this.processEvents(pos, ratesByExchange);
        else await this.confirmEvents(pos, ratesByExchange);
        const pending = (pos.events || []).filter((e) => !e.paid);
        const mark = ratesByExchange[pos.longEx]?.[pos.symbol]?.mark || pos.long.entry;

        if (!pending.length) {
          // Усі виплати отримано
          const deadline = this.convergeDeadline(pos, ratesByExchange);
          if (now >= deadline) {
            const waited = deadline > pos.exitAt ? ', ціни так і не зійшлися' : '';
            await this.closePair(pos, `${duration(now - pos.endTs)} після виплати${waited}`);
            continue;
          }
          const q = await this.exitQuote(pos);
          // Прибуток від цін = різниця на вході − різниця на виході. «Зійшлися» = різниця ≈ 0 І не гірша, ніж була на вході:
          // якщо зайшли з несприятливою різницею (−0.3%), її сходження до 0 — це збиток, тоді чекаємо, поки повернеться до рівня входу
          const notWorse = q && (pos.entryBasis ?? 0) - q.exitBasis >= -this.cfg.convergePct;
          if (q && q.exitBasis <= this.cfg.convergePct && notWorse) {
            await this.closePair(pos, `ціни зійшлися (різниця ${pct(q.exitBasis)}, на вході була ${pct(pos.entryBasis ?? 0)}) після виплати`, q);
            continue;
          }
          if (q && now >= pos.exitAt) {
            // Час вийшов, але ціни не зійшлися: виходимо, лише якщо угода вже в плюсі; інакше чекаємо сходження
            const total = q.pricePnl - q.closeFees + pos.fundingAccrued - pos.feesPaid;
            if (total >= 0) {
              await this.closePair(pos, `угода в плюсі ${sgn(total)} — фіксую`, q);
              continue;
            }
            if (!pos.convergeWaitNotified) {
              pos.convergeWaitNotified = true;
              this.state.save();
              await this.notify(
                `⏳ ${pos.symbol}: виплату отримано, але ціни не зійшлися — вихід зараз дав би ${sgn(total)} ${this.cfg.quote}.\n` +
                  `Позиція захеджована, чекаю сходження до ${clock(deadline, this.cfg.timezone)}. Захист від ліквідації працює.`
              );
            }
          }
        } else if (!pending.some((e) => e.ts > now)) {
          // Час усіх виплат минув, але біржа ще не підтвердила нарахування — чекаємо (захист від ліквідації працює)
          continue;
        } else {
          // Рахуємо лише виплати, які ще попереду: минулі вже відбулись, вихід їх не скасує
          const future = pending.filter((e) => e.ts > now);
          const remaining = future.reduce((a, e) => a + contrib(e), 0) * pos.base * mark;
          // Ставка розвернулась і решта виплат принесе мінус — виходимо, не чекаючи
          if (remaining < 0) {
            await this.closePair(pos, `ставка змінилась, очікуваний фандінг став ${sgn(remaining)} ${this.cfg.quote}`);
            continue;
          }
          if (this.cfg.earlyExit) {
            const q = await this.exitQuote(pos);
            if (q && q.pricePnl - q.closeFees > remaining && q.exitBasis <= this.cfg.convergePct) {
              await this.closePair(pos, `ціни зійшлися ще ДО виплати: прибуток ${sgn(q.pricePnl - q.closeFees)} > очікуваний фандінг ${sgn(remaining)}`, q);
              continue;
            }
          }
        }
      } catch (e) {
        log.error(`${pos.symbol}: помилка супроводу: ${e.message}`);
      }
    }
  }

  /**
   * Чи не наближається якась нога до ліквідації. Обидві біржі перевіряються паралельно.
   * Ризик = частка шляху від ціни входу до ціни ліквідації, яку ціна вже пройшла.
   * Live — ціна ліквідації і mark з позиції на біржі; paper — оцінка за стаканом і плечем.
   * @returns {Promise<{reason:string, missing?:string[]}|undefined>}
   */
  async liquidationRisk(pos, ratesByExchange) {
    const limit = this.cfg.liqClosePct ?? 0.6;
    const legs = [['short', pos.shortEx], ['long', pos.longEx]];
    const progress = (legKey, mark, liq) => {
      const e = pos[legKey].entry;
      if (!(mark > 0) || !(liq > 0) || liq === e) return 0;
      return (mark - e) / (liq - e);
    };
    const results = await Promise.all(
      legs.map(async ([legKey, exId]) => {
        const ex = this.ex[exId];
        const leg = pos[legKey];
        if (this.paper) {
          let mark;
          try {
            const ob = await ex.fetchOrderBook(pos.symbol);
            const b = ob.bids[0] && ob.bids[0][0];
            const a = ob.asks[0] && ob.asks[0][0];
            if (b && a) mark = (a + b) / 2;
          } catch (e) {
            log.debug(`${exId} orderbook ${pos.symbol}: ${e.message}`);
          }
          mark = mark || ratesByExchange[exId]?.[pos.symbol]?.mark;
          const pr = progress(legKey, mark, leg.liq || this.estimateLiq(pos, legKey));
          return pr >= limit ? { reason: `${legKey.toUpperCase()} ${exId}: ціна пройшла ${pct(pr, 0)} шляху до ліквідації` } : undefined;
        }
        if (!(leg.contracts > 0)) return undefined;
        try {
          const p = await ex.fetchPosition(pos.symbol);
          if (!p) {
            // Одна порожня відповідь API ще не означає, що позиції немає — потрібні 2 перевірки поспіль
            leg.missingChecks = (leg.missingChecks || 0) + 1;
            if (leg.missingChecks < 2) return undefined;
            return { reason: `позиція ${legKey.toUpperCase()} на ${exId} зникла (спрацював стоп / ліквідація / ADL / ручне закриття) — закриваю другу ногу`, missing: [legKey] };
          }
          leg.missingChecks = 0;
          const actual = Math.abs(p.contracts || 0);
          if (Math.abs(actual - leg.contracts) > Math.max(leg.contracts * 1e-6, (ex.contractStep(pos.symbol) || 0) * 0.5)) {
            // Біржа частково зменшила ногу (ADL / часткова ліквідація) — хедж порушено, закриваємо пару
            const was = leg.contracts;
            leg.contracts = actual;
            return { reason: `${legKey.toUpperCase()} ${exId}: розмір ноги змінила біржа (${was} → ${actual} контр., ADL/часткова ліквідація) — хедж порушено` };
          }
          const mult = ex.mult[pos.symbol] || 1;
          const mark = p.markPrice ? p.markPrice / mult : undefined;
          if (p.liquidationPrice > 0) {
            const liq = p.liquidationPrice / mult;
            if (legKey === 'short' ? liq > leg.entry : liq < leg.entry) leg.liq = liq;
          }
          const pr = progress(legKey, mark, leg.liq || this.estimateLiq(pos, legKey));
          if (pr >= limit) return { reason: `${legKey.toUpperCase()} ${exId}: ціна пройшла ${pct(pr, 0)} шляху до ліквідації` };
        } catch (e) {
          pos.riskErrors = (pos.riskErrors || 0) + 1;
          log.warn(`${exId} fetchPosition ${pos.symbol}: ${e.message}`);
          if (pos.riskErrors === 6) await this.notify(`⚠️ ${pos.symbol}: ${exId} не відповідає ~30 с — не можу перевірити ризик ліквідації. Стопи на біржі стоять.`);
          return undefined;
        }
        pos.riskErrors = 0;
        return undefined;
      })
    );
    const hits = results.filter(Boolean);
    if (!hits.length) return undefined;
    return { reason: hits.map((h) => h.reason).join('; '), missing: hits.flatMap((h) => h.missing || []) };
  }

  /**
   * Закриває пару тією ж кількістю монет, якою відкривали.
   * @param {{urgent?:boolean, missing?:string[]}} [opt] urgent — одразу ринком; missing — ноги, яких уже немає на біржі
   */
  async closePair(pos, reason, quote, opt = {}) {
    const S = this.ex[pos.shortEx];
    const L = this.ex[pos.longEx];
    let exitS;
    let exitL;
    let feeS;
    let feeL;
    let typeS;
    let typeL;
    const notes = [];
    try {
      if (this.paper) {
        const q = quote || (await this.exitQuote(pos));
        if (!q) throw new Error('порожній стакан');
        exitS = q.askS;
        exitL = q.bidL;
        feeS = pos.base * exitS * S.takerFee(pos.symbol);
        feeL = pos.base * exitL * L.takerFee(pos.symbol);
        typeS = typeL = opt.urgent || this.cfg.orderType === 'market' ? 'market' : 'limit';
      } else {
        if (!quote && !opt.missing) quote = await this.exitQuote(pos).catch(() => undefined); // для статистики проковзування
        // Нога, якої вже немає на біржі (стоп/ліквідація/вручну), не закривається.
        for (const legKey of opt.missing || []) {
          const leg = pos[legKey];
          if (!(leg.contracts > 0)) continue;
          const { price, src } = await this.externalExitPrice(pos, legKey);
          Object.assign(leg, { contracts: 0, exit: price, exitFee: 0, closedContracts: leg.contracts, exitEstimated: src !== 'факт з біржі' });
          notes.push(`${legKey.toUpperCase()} закрила біржа, ціна ${fmt(price, 8)} (${src})`);
        }
        const closeLeg = async (ex, side, leg, legKey) => {
          if (!(leg.contracts > 0)) return { average: leg.exit, fee: leg.exitFee || 0, filled: 0, type: leg.exitType };
          const r = await this.closeLegWithRetry(ex, pos.symbol, side, leg.contracts, { leverage: pos.leverage, marginMode: this.cfg.marginMode, urgent: opt.urgent }, opt.retry ? 2 : 5);
          if (r && r.externallyClosed && !r.average) {
            const { price, src } = await this.externalExitPrice(pos, legKey);
            r.average = price;
            notes.push(`${legKey.toUpperCase()} закрила біржа, ціна ${fmt(price, 8)} (${src})`);
          }
          return r;
        };
        const shortContracts = pos.short.contracts;
        const longContracts = pos.long.contracts;
        const [rs, rl] = await Promise.all([closeLeg(S, 'buy', pos.short, 'short'), closeLeg(L, 'sell', pos.long, 'long')]);
        if (rs && pos.short.contracts > 0) Object.assign(pos.short, { contracts: 0, exit: rs.average, exitFee: rs.fee, exitType: rs.type, closedContracts: shortContracts });
        if (rl && pos.long.contracts > 0) Object.assign(pos.long, { contracts: 0, exit: rl.average, exitFee: rl.fee, exitType: rl.type, closedContracts: longContracts });
        if (!rs || !rl) {
          // Часткове закриття: позицію лишаємо у стані, щоб не загубити незакриту ногу
          pos.closeError = reason;
          this.state.save();
          return undefined;
        }
        exitS = rs.average || pos.short.entry;
        exitL = rl.average || pos.long.entry;
        feeS = rs.fee ?? pos.base * exitS * S.takerFee(pos.symbol);
        feeL = rl.fee ?? pos.base * exitL * L.takerFee(pos.symbol);
        typeS = rs.type;
        typeL = rl.type;
        await this.cancelProtection(pos);
      }
    } catch (e) {
      log.error(`${pos.symbol}: помилка закриття: ${e.message}`);
      return undefined;
    }

    // Live: пробуємо взяти фактичний фандінг з історії бірж замість оцінки
    let fundingSource = this.paper ? 'розрахунок' : 'оцінка';
    if (!this.paper && (pos.events || []).some((e) => e.paid)) {
      try {
        const since = pos.openedAt - 60000;
        const [fS, fL] = await Promise.all([S.fetchFundingPaid(pos.symbol, since), L.fetchFundingPaid(pos.symbol, since)]);
        if (fS !== undefined && fL !== undefined) {
          const actual = fS + fL;
          this.state.addDaily('funding', actual - pos.fundingAccrued);
          pos.fundingAccrued = actual;
          fundingSource = 'факт з бірж';
        }
      } catch (e) {
        log.debug(`fetchFundingHistory ${pos.symbol}: ${e.message}`);
      }
    }

    const closeFees = feeS + feeL;
    const pricePnl = (pos.short.entry - exitS) * pos.base + (exitL - pos.long.entry) * pos.base;
    const pnl = pricePnl + pos.fundingAccrued - pos.feesPaid - closeFees;
    // Проковзування: наскільки фактичні ціни гірші за очікувані (додатне — гірше), %
    const slip = (exp, act, side) => (exp > 0 && act > 0 ? (side === 'sell' ? (exp - act) / exp : (act - exp) / exp) : undefined);
    const ee = pos.expectedEntry || {};
    const slipEntry = [slip(ee.short, pos.short.entry, 'sell'), slip(ee.long, pos.long.entry, 'buy')].filter(Number.isFinite);
    const slipExit = quote ? [slip(quote.askS, exitS, 'buy'), slip(quote.bidL, exitL, 'sell')].filter(Number.isFinite) : [];
    const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : undefined);
    const closed = this.state.closePosition(pos.id, {
      exitShort: exitS, exitLong: exitL, pricePnl, closeFees, pnl, reason,
      slipEntry: avg(slipEntry), slipExit: avg(slipExit),
      unconfirmedFunding: (pos.events || []).some((e) => e.paid && e.confirmed === false),
    });
    const s = this.state.data.stats;
    const cS = pos.short.closedContracts || pos.short.contracts;
    const cL = pos.long.closedContracts || pos.long.contracts;
    const paidEvents = (pos.events || []).filter((e) => e.paid);
    await this.notify(
      `❎ ВИХІД ${pos.symbol}${this.paper ? ' [PAPER]' : ''} — ${reason}\n` +
        `${this.orderLine('buy', pos.shortEx, pos.symbol, pos.base, cS, exitS, feeS, typeS)}\n` +
        `${this.orderLine('sell', pos.longEx, pos.symbol, pos.base, cL, exitL, feeL, typeL)}\n` +
        (notes.length ? `${notes.join('\n')}\n` : '') +
        `Утримання: ${duration(this.now() - pos.openedAt)}\n` +
        (paidEvents.length
          ? `Отримані виплати:\n${paidEvents.map((e) => `   ${clock(e.ts, this.cfg.timezone)} ${e.ex} ${e.side.toUpperCase()} ${pct(e.rate, 4)} → ${sgn(e.amount)}`).join('\n')}\n`
          : 'Виплат не було\n') +
        `Різниця цін між біржами: на вході ${pct(pos.entryBasis ?? 0)}, на виході ${pct((exitS - exitL) / exitL)}\n` +
        `Фандінг: ${sgn(pos.fundingAccrued)} (${fundingSource}) | Різниця цін: ${sgn(pricePnl)} | Комісії: −${fmt(pos.feesPaid + closeFees)}\n` +
        `${pnl >= 0 ? '💰' : '🔻'} PnL угоди: ${sgn(pnl)} ${this.cfg.quote}\n` +
        `Загальний PnL: ${sgn(s.realizedPnl)} ${this.cfg.quote} (${s.trades} угод)`
    );
    if (this.guard) await this.guard.onTradeClosed(pnl);
    await this.maybeAutoBan(pos.symbol);
    return closed;
  }

  /** Ціна, за якою біржа сама закрила ногу: факт з історії угод → поточний стакан → ціна стопу. */
  async externalExitPrice(pos, legKey) {
    const ex = this.ex[legKey === 'short' ? pos.shortEx : pos.longEx];
    const side = legKey === 'short' ? 'buy' : 'sell';
    const leg = pos[legKey];
    try {
      const price = await ex.lastClosePrice(pos.symbol, side, pos.openedAt);
      if (price) return { price, src: 'факт з біржі' };
    } catch (e) {
      log.debug(`${ex.id} fetchMyTrades: ${e.message}`);
    }
    try {
      const ob = await ex.fetchOrderBook(pos.symbol);
      const lv = side === 'buy' ? ob.asks : ob.bids;
      if (lv[0]) return { price: lv[0][0], src: 'оцінка за стаканом' };
    } catch (e) {
      log.debug(`${ex.id} orderbook: ${e.message}`);
    }
    return { price: leg.stopPrice || leg.liq || leg.entry, src: 'оцінка (ціна стопу)' };
  }

  /** Монета дала autoBanLosses збиткових угод поспіль — у чорний список (зняти: /coinreset). */
  async maybeAutoBan(symbol) {
    const n = this.cfg.autoBanLosses || 0;
    if (!(n > 0) || !this.coins) return;
    const coin = coinOf(symbol);
    const last = this.state.data.closed.filter((c) => c.symbol === symbol).slice(-n);
    if (last.length < n || !last.every((c) => c.pnl < 0) || this.coins.isBanned(coin, '*')) return;
    this.coins.ban(coin, '*');
    await this.notify(`🚫 ${coin}: ${n} збиткових угод поспіль — монету автоматично додано в чорний список. Повернути: /coinreset ${coin}`);
  }
}

module.exports = { Trader, vwap, maxDepth };
