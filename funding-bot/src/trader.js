'use strict';

const log = require('./logger');
const { buildWindow, contrib } = require('./scanner');
const { clock, duration } = require('./time');
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
    this.now = () => Date.now();
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
    if (!(target > 0)) return { error: 'не задано кількість монет (/qty)' };
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

  orderLine(side, exId, symbol, base, contracts, price, fee) {
    const cs = this.ex[exId].unitSize(symbol);
    const contractsTxt = cs !== 1 ? ` (${fmt(contracts, 6)} контр.)` : '';
    return (
      `${side === 'sell' ? '🔴 SELL' : '🟢 BUY'} ${fmt(base, 8)} ${coinOf(symbol)}${contractsTxt} @ ${fmt(price, 8)} на ${exId}` +
      ` ≈ ${fmt(base * price, 2)} ${this.cfg.quote}, комісія ${fmt(fee, 4)}`
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
      // вільний баланс × плече, 15% маржі лишаємо в запасі
      limits[`баланс ${shortEx} ×${leverage}`] = (fS * leverage * 0.85) / mid;
      limits[`баланс ${longEx} ×${leverage}`] = (fL * leverage * 0.85) / mid;
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
    // Однакова кількість на обох біржах — кратна спільному кроку лотів
    const step = this.pairStep(symbol, S, L);
    const exact = Number.isFinite(base) ? (step ? floorToStep(base, step) : base) : 0;
    return { base: exact, raw: base, step, leverage, mid, limits, limitedBy, books: { obS, obL } };
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
    this.busy.add(symbol);
    const skip = (why) => {
      this.skipped.set(key, win.startTs);
      log.info(`${symbol} ${shortEx}/${longEx} (виплата ${clock(win.startTs, this.cfg.timezone)}): пропуск — ${why}`);
      return false;
    };
    try {
      // 1) Свіжі ставки прямо перед входом — прогнозна ставка може змінитися аж до виплати
      const [rS, rL] = await Promise.all([S.fetchFundingRate(symbol), L.fetchFundingRate(symbol)]);
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
      if (this.now() > win.startTs - this.cfg.entryMinSec * 1000) return skip('не встигли до виплати');

      // 3) Відкриття обох ніг
      const legs = await this.executeOpen(symbol, S, L, sizing, pxS, pxL, leverage);
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
          `${this.orderLine('sell', shortEx, symbol, pos.base, pos.short.contracts, pos.short.entry, legs.shortFee)}\n` +
          `${this.orderLine('buy', longEx, symbol, pos.base, pos.long.contracts, pos.long.entry, legs.longFee)}\n` +
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
      return true;
    } catch (e) {
      log.error(`${symbol}: помилка відкриття: ${e.message}`);
      return false;
    } finally {
      this.busy.delete(symbol);
      for (const [k, ts] of this.skipped) if (ts < now - 3600000) this.skipped.delete(k);
    }
  }

  async executeOpen(symbol, S, L, sizing, pxS, pxL, leverage = this.cfg.leverage) {
    if (this.paper) {
      const shortFee = sizing.base * pxS * S.takerFee(symbol);
      const longFee = sizing.base * pxL * L.takerFee(symbol);
      return {
        base: sizing.base,
        short: { filled: sizing.cS, average: pxS },
        long: { filled: sizing.cL, average: pxL },
        shortFee,
        longFee,
        fees: shortFee + longFee,
      };
    }
    // Обидві ноги паралельно — мінімізуємо час, коли позиція не захеджована
    const opts = { leverage, marginMode: this.cfg.marginMode };
    const [rs, rl] = await Promise.allSettled([
      S.marketOrder(symbol, 'sell', sizing.cS, opts),
      L.marketOrder(symbol, 'buy', sizing.cL, opts),
    ]);
    if (rs.status === 'fulfilled' && rl.status === 'fulfilled') {
      const short = rs.value;
      const long = rl.value;
      short.average = short.average || pxS;
      long.average = long.average || pxL;
      const shortFee = short.fee ?? S.contractsToBase(symbol, short.filled) * short.average * S.takerFee(symbol);
      const longFee = long.fee ?? L.contractsToBase(symbol, long.filled) * long.average * L.takerFee(symbol);
      const base = await this.equalizeLegs(symbol, S, L, short, long);
      if (!(base > 0)) {
        await this.notify(`⚠️ ${symbol}: після вирівнювання ніг позиції не лишилось — вхід скасовано`);
        return undefined;
      }
      return { base, short, long, shortFee, longFee, fees: shortFee + longFee };
    }
    // Одна нога не відкрилась — відкатуємо іншу
    const failed = [];
    if (rs.status === 'rejected') failed.push(`SHORT ${S.id}: ${rs.reason && rs.reason.message}`);
    if (rl.status === 'rejected') failed.push(`LONG ${L.id}: ${rl.reason && rl.reason.message}`);
    const rollback = [];
    if (rs.status === 'fulfilled') {
      const o = await this.closeLegWithRetry(S, symbol, 'buy', rs.value.filled, opts);
      if (o) rollback.push(this.orderLine('buy', S.id, symbol, S.contractsToBase(symbol, o.filled), o.filled, o.average, o.fee));
    }
    if (rl.status === 'fulfilled') {
      const o = await this.closeLegWithRetry(L, symbol, 'sell', rl.value.filled, opts);
      if (o) rollback.push(this.orderLine('sell', L.id, symbol, L.contractsToBase(symbol, o.filled), o.filled, o.average, o.fee));
    }
    await this.notify(`⚠️ ${symbol}: не вдалося відкрити пару, відкат.\n${failed.join('\n')}${rollback.length ? `\nВідкат:\n${rollback.join('\n')}` : ''}`);
    return undefined;
  }

  /**
   * Біржі могли виконати ордери не повністю. Доводимо обидві ноги до ОДНАКОВОЇ кількості монет:
   * найбільше кратне спільного кроку, що ≤ меншої ноги; зайве закриваємо reduceOnly.
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
      try {
        const o = await this.closeLegWithRetry(ex, symbol, side, c, {}, 3);
        if (!o) continue;
        leg.filled = Number((leg.filled - o.filled).toPrecision(12));
        lines.push(this.orderLine(side, ex.id, symbol, ex.contractsToBase(symbol, o.filled), o.filled, o.average, o.fee));
      } catch (e) {
        lines.push(`помилка на ${ex.id}: ${e.message}`);
      }
    }
    const fS = S.contractsToBase(symbol, short.filled);
    const fL = L.contractsToBase(symbol, long.filled);
    await this.notify(
      `⚖️ ${symbol}: біржі виконали різну кількість (${fmt(bS, 8)} / ${fmt(bL, 8)}), вирівнюю до ${fmt(target, 8)}\n${lines.join('\n')}` +
        (fS !== fL ? `\n🚨 Ноги досі різні: ${S.id} ${fmt(fS, 8)}, ${L.id} ${fmt(fL, 8)} — перевірте вручну!` : '')
    );
    return Math.min(fS, fL);
  }

  /**
   * Закриття (reduceOnly) з повторами. Якщо біржа виконала частково — дозакриває залишок.
   * @returns {Promise<{filled:number, average:number, fee:number|undefined}|undefined>}
   */
  async closeLegWithRetry(exchange, symbol, side, contracts, opts = {}, attempts = 4) {
    let left = contracts;
    let filled = 0;
    let cost = 0;
    let fee;
    for (let i = 1; i <= attempts && left > 0; i++) {
      try {
        const o = await exchange.marketOrder(symbol, side, left, { ...opts, reduceOnly: true });
        const f = Math.min(o.filled || 0, left);
        filled = Number((filled + f).toPrecision(12));
        cost += f * (o.average || 0);
        if (o.fee !== undefined) fee = (fee || 0) + o.fee;
        left = Number((left - f).toPrecision(12));
        if (left > 0) log.warn(`${exchange.id} ${symbol}: закрито частково, лишилось ${left} контр. — дозакриваю`);
      } catch (e) {
        log.error(`${exchange.id} ${symbol}: закриття ноги, спроба ${i}/${attempts}: ${e.message}`);
        await sleep(500 * 2 ** i);
      }
    }
    if (left > 0) {
      await this.notify(`🚨 ${symbol}: НЕ ВДАЛОСЯ ЗАКРИТИ ${filled > 0 ? `залишок ${left} контр. ` : ''}ноги на ${exchange.id}! Потрібне ручне втручання.`);
      return undefined;
    }
    return { filled, average: filled > 0 ? cost / filled : undefined, fee };
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

  /** Перевірка всіх позицій: нарахування, вихід після виплати / при сходженні цін / ризик. */
  async manage(ratesByExchange) {
    const now = this.now();
    for (const pos of [...this.state.positions]) {
      try {
        if (pos.closeError) {
          await this.closePair(pos, `повторна спроба закриття (${pos.closeError})`);
          continue;
        }
        this.processEvents(pos, ratesByExchange);
        const pending = (pos.events || []).filter((e) => !e.paid);
        const mark = ratesByExchange[pos.longEx]?.[pos.symbol]?.mark || pos.long.entry;

        if (!pending.length) {
          // Усі виплати отримано: вихід, як тільки ціни зійшлися, або через exitAfterSec
          if (now >= (pos.exitAt ?? 0)) {
            await this.closePair(pos, `${duration(now - pos.endTs)} після виплати`);
            continue;
          }
          const q = await this.exitQuote(pos);
          if (q && q.exitBasis <= this.cfg.convergePct) {
            await this.closePair(pos, `ціни зійшлися (різниця ${pct(q.exitBasis)}) після виплати`, q);
            continue;
          }
        } else {
          const remaining = pending.reduce((a, e) => a + contrib(e), 0) * pos.base * mark;
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
        // Ризик ліквідації — не частіше ніж раз на 30 с
        if (!pos.lastRiskCheck || now - pos.lastRiskCheck > 30000) {
          pos.lastRiskCheck = now;
          const risk = await this.liquidationRisk(pos, ratesByExchange);
          if (risk) await this.closePair(pos, risk);
        }
      } catch (e) {
        log.error(`${pos.symbol}: помилка супроводу: ${e.message}`);
      }
    }
  }

  async liquidationRisk(pos, ratesByExchange) {
    const buf = this.cfg.liqBufferPct;
    if (this.paper) {
      // Груба модель ізольованої маржі: ліквідація при русі ~1/leverage
      const lev = pos.leverage || this.cfg.leverage;
      const markS = ratesByExchange[pos.shortEx]?.[pos.symbol]?.mark;
      const markL = ratesByExchange[pos.longEx]?.[pos.symbol]?.mark;
      if (markS && (pos.short.entry * (1 + 1 / lev) - markS) / markS < buf) return `SHORT ${pos.shortEx} близько до ліквідації`;
      if (markL && (markL - pos.long.entry * (1 - 1 / lev)) / markL < buf) return `LONG ${pos.longEx} близько до ліквідації`;
      return undefined;
    }
    for (const [exId, side] of [[pos.shortEx, 'short'], [pos.longEx, 'long']]) {
      try {
        const p = await this.ex[exId].fetchPosition(pos.symbol);
        if (!p) return `позиція ${side} на ${exId} зникла (ліквідація/ручне закриття?)`;
        if (p.liquidationPrice && p.markPrice) {
          const dist = Math.abs(p.markPrice - p.liquidationPrice) / p.markPrice;
          if (dist < buf) return `${side} ${exId}: до ліквідації ${pct(dist, 1)}`;
        }
      } catch (e) {
        log.warn(`${exId} fetchPosition ${pos.symbol}: ${e.message}`);
      }
    }
    return undefined;
  }

  /** Закриває пару тією ж кількістю монет, якою відкривали. */
  async closePair(pos, reason, quote) {
    const S = this.ex[pos.shortEx];
    const L = this.ex[pos.longEx];
    let exitS;
    let exitL;
    let feeS;
    let feeL;
    try {
      if (this.paper) {
        const q = quote || (await this.exitQuote(pos));
        if (!q) throw new Error('порожній стакан');
        exitS = q.askS;
        exitL = q.bidL;
        feeS = pos.base * exitS * S.takerFee(pos.symbol);
        feeL = pos.base * exitL * L.takerFee(pos.symbol);
      } else {
        // Нога, закрита на попередній (частково невдалій) спробі, повторно не закривається
        const closeLeg = (ex, side, leg) =>
          leg.contracts > 0
            ? this.closeLegWithRetry(ex, pos.symbol, side, leg.contracts, { leverage: pos.leverage, marginMode: this.cfg.marginMode })
            : Promise.resolve({ average: leg.exit, fee: leg.exitFee || 0, filled: 0 });
        const shortContracts = pos.short.contracts;
        const longContracts = pos.long.contracts;
        const [rs, rl] = await Promise.all([closeLeg(S, 'buy', pos.short), closeLeg(L, 'sell', pos.long)]);
        if (rs && pos.short.contracts > 0) Object.assign(pos.short, { contracts: 0, exit: rs.average, exitFee: rs.fee, closedContracts: shortContracts });
        if (rl && pos.long.contracts > 0) Object.assign(pos.long, { contracts: 0, exit: rl.average, exitFee: rl.fee, closedContracts: longContracts });
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
    const closed = this.state.closePosition(pos.id, { exitShort: exitS, exitLong: exitL, pricePnl, closeFees, pnl, reason });
    const s = this.state.data.stats;
    const cS = pos.short.closedContracts || pos.short.contracts;
    const cL = pos.long.closedContracts || pos.long.contracts;
    const paidEvents = (pos.events || []).filter((e) => e.paid);
    await this.notify(
      `❎ ВИХІД ${pos.symbol}${this.paper ? ' [PAPER]' : ''} — ${reason}\n` +
        `${this.orderLine('buy', pos.shortEx, pos.symbol, pos.base, cS, exitS, feeS)}\n` +
        `${this.orderLine('sell', pos.longEx, pos.symbol, pos.base, cL, exitL, feeL)}\n` +
        `Утримання: ${duration(this.now() - pos.openedAt)}\n` +
        (paidEvents.length
          ? `Отримані виплати:\n${paidEvents.map((e) => `   ${clock(e.ts, this.cfg.timezone)} ${e.ex} ${e.side.toUpperCase()} ${pct(e.rate, 4)} → ${sgn(e.amount)}`).join('\n')}\n`
          : 'Виплат не було\n') +
        `Фандінг: ${sgn(pos.fundingAccrued)} (${fundingSource}) | Різниця цін: ${sgn(pricePnl)} | Комісії: −${fmt(pos.feesPaid + closeFees)}\n` +
        `${pnl >= 0 ? '💰' : '🔻'} PnL угоди: ${sgn(pnl)} ${this.cfg.quote}\n` +
        `Загальний PnL: ${sgn(s.realizedPnl)} ${this.cfg.quote} (${s.trades} угод)`
    );
    return closed;
  }
}

module.exports = { Trader, vwap, maxDepth };
