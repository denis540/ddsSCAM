'use strict';

/** Несприятлива різниця цін як витрата (≤ 0), або 0, якщо BASIS_COST=false. */
function spreadCost(basis, cfg) {
  return cfg && cfg.basisCost === false ? 0 : Math.min(basis, 0);
}

/**
 * Стратегія «під конкретну виплату фандінгу».
 *
 * Для кожної монети і кожної пари бірж (SHORT на X, LONG на Y) будуємо майбутні виплати
 * обох бірж на горизонті maxWindowHours. Вікно утримання [start, end] — від однієї виплати до іншої
 * (або одна виплата). Бот входить за entryBeforeSec до start і виходить після end
 * (або раніше, якщо ціни зійшлися). Усі виплати обох ніг, що потрапляють у вікно, враховуються:
 *   SHORT отримує +rate, LONG отримує −rate (тобто платить при позитивній ставці).
 *
 * Це покриває всі варіанти:
 *  - виплати в один час на обох біржах  -> profit = rateShort − rateLong;
 *  - виплата лише на одній біржі у вікні (інша пізніше) -> profit = ставка лише цієї ноги, друга нога — чистий хедж;
 *  - різні інтервали (1h vs 8h) -> у вікно потрапляє кілька виплат швидшої біржі;
 *  - від'ємні ставки -> LONG на біржі з від'ємною ставкою отримує виплату.
 *
 * Ставка відома лише для найближчої виплати кожної біржі; наступні рахуються за поточною ставкою
 * і позначаються як оцінка (estimated).
 */

const HOUR = 3600 * 1000;
const base = (symbol) => symbol.split('/')[0];

/** Майбутні виплати однієї ноги в межах [now, now + horizonMs]. */
function upcomingEvents(r, exId, side, now, horizonMs) {
  if (!r || !r.nextTs || !Number.isFinite(r.rate)) return [];
  const iv = (r.intervalH || 8) * HOUR;
  let t = r.nextTs;
  let est = false;
  while (t <= now) {
    t += iv; // дані застаріли (виплата щойно пройшла) — ставка вже не точна
    est = true;
  }
  const out = [];
  for (let k = 0; t <= now + horizonMs; t += iv, k++) {
    out.push({ ts: t, ex: exId, side, rate: r.rate, est: est || k > 0 });
  }
  return out;
}

/** Внесок виплати в наш PnL (частка від номіналу). */
const contrib = (ev) => (ev.side === 'short' ? ev.rate : -ev.rate);

function sumFunding(events) {
  return events.reduce((a, e) => a + contrib(e), 0);
}

/**
 * Оцінює конкретне вікно [startTs, endTs] для пари.
 * @returns {object|undefined}
 */
function buildWindow({ symbol, shortEx, longEx, s, l, startTs, endTs, now, cfg, fees }) {
  const horizon = endTs - now + 1;
  const events = [
    ...upcomingEvents(s, shortEx, 'short', now, horizon),
    ...upcomingEvents(l, longEx, 'long', now, horizon),
  ]
    .filter((e) => e.ts >= startTs && e.ts <= endTs)
    .sort((a, b) => a.ts - b.ts);
  if (!events.length || events[0].ts !== startTs) return undefined;
  const funding = sumFunding(events);
  const basis = s.mark && l.mark ? (s.mark - l.mark) / l.mark : 0;
  const net = funding - fees + spreadCost(basis, cfg);
  return {
    symbol,
    shortEx,
    longEx,
    startTs,
    endTs,
    events,
    funding,
    fees,
    basis,
    net,
    estimated: events.some((e) => e.est),
    shortRate: s.rate,
    longRate: l.rate,
    shortIntervalH: s.intervalH,
    longIntervalH: l.intervalH,
  };
}

/**
 * Усі вікна, що проходять фільтри. Для кожної (монета, short, long, start) — найкраще за чистим профітом.
 * @param {(exId:string, symbol:string)=>number} takerFee
 */
/**
 * @param {(coin:string, exA:string, exB:string, markA?:number, markB?:number)=>{ok:boolean}} [coinCheck]
 *        перевірка, що це та сама монета (адреса контракту / ціна / ручні рішення)
 */
function planWindows(ratesByExchange, cfg, takerFee = () => cfg.defaultTakerFee, now = Date.now(), coinCheck) {
  const maxWin = cfg.maxWindowHours * HOUR;
  const horizon = maxWin + (cfg.lookaheadHours || 8) * HOUR;
  const minStart = now + (cfg.entryMinSec || 0) * 1000;

  const bySymbol = new Map();
  for (const [exId, rates] of Object.entries(ratesByExchange)) {
    for (const [symbol, r] of Object.entries(rates)) {
      if (!Number.isFinite(r.rate) || Math.abs(r.rate) > cfg.maxAbsFundingRate || !r.nextTs) continue;
      if (cfg.whitelist.length && !cfg.whitelist.includes(base(symbol))) continue;
      if (cfg.blacklist.includes(base(symbol))) continue;
      if (!bySymbol.has(symbol)) bySymbol.set(symbol, []);
      bySymbol.get(symbol).push({ exId, r });
    }
  }

  const out = [];
  for (const [symbol, entries] of bySymbol) {
    if (entries.length < 2) continue;
    for (const S of entries) {
      for (const L of entries) {
        if (S.exId === L.exId) continue;
        if (coinCheck) {
          if (!coinCheck(base(symbol), S.exId, L.exId, S.r.mark, L.r.mark).ok) continue;
        } else if (cfg.coinPriceTol && S.r.mark && L.r.mark && Math.abs(S.r.mark - L.r.mark) / Math.min(S.r.mark, L.r.mark) > cfg.coinPriceTol) {
          continue; // ціни надто різні — різні монети з однаковою назвою
        }
        // Швидке відсікання: навіть максимум можливого фандінгу не дотягує до порогу
        const nS = cfg.allowEstimated ? Math.ceil(maxWin / ((S.r.intervalH || 8) * HOUR)) + 1 : 1;
        const nL = cfg.allowEstimated ? Math.ceil(maxWin / ((L.r.intervalH || 8) * HOUR)) + 1 : 1;
        if (Math.max(S.r.rate, 0) * nS + Math.max(-L.r.rate, 0) * nL < cfg.minFunding) continue;

        const fees = 2 * (takerFee(S.exId, symbol) + takerFee(L.exId, symbol));
        const events = [
          ...upcomingEvents(S.r, S.exId, 'short', now, horizon),
          ...upcomingEvents(L.r, L.exId, 'long', now, horizon),
        ].sort((a, b) => a.ts - b.ts);
        // Межі вікна — лише НАЙБЛИЖЧІ виплати кожної біржі (їхні ставки відомі).
        // Варіанти: [виплата A], [виплата B], [від A до B]. Проміжні виплати швидшої біржі потрапляють у вікно.
        const firstS = events.find((e) => e.side === 'short');
        const firstL = events.find((e) => e.side === 'long');
        const times = [...new Set([firstS && firstS.ts, firstL && firstL.ts].filter(Boolean))].sort((a, b) => a - b);
        for (let i = 0; i < times.length; i++) {
          if (times[i] < minStart) continue;
          let best;
          for (let j = i; j < times.length && times[j] - times[i] <= maxWin; j++) {
            const w = buildWindow({ symbol, shortEx: S.exId, longEx: L.exId, s: S.r, l: L.r, startTs: times[i], endTs: times[j], now, cfg, fees });
            if (!w) continue;
            if (!cfg.allowEstimated && w.estimated) continue;
            if (w.funding < cfg.minFunding || w.net < cfg.minProfit) continue;
            if (w.basis < -cfg.maxEntryBasisPct) continue;
            if (!best || w.net > best.net) best = w;
          }
          if (best) out.push(best);
        }
      }
    }
  }
  return out.sort((a, b) => b.net - a.net);
}

/** Вікна, у які час заходити зараз (до старту від entryMinSec до entryBeforeSec). */
function dueWindows(windows, cfg, now = Date.now()) {
  return windows.filter((w) => {
    const left = w.startTs - now;
    return left >= cfg.entryMinSec * 1000 && left <= cfg.entryBeforeSec * 1000;
  });
}

module.exports = { spreadCost, planWindows, buildWindow, dueWindows, upcomingEvents, sumFunding, contrib };
