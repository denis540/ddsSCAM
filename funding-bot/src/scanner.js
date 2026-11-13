'use strict';

/**
 * Пошук арбітражних можливостей по фандінгу.
 *
 * Логіка: на біржі S фандінг вищий -> відкриваємо SHORT (шорт отримує позитивний фандінг),
 * на біржі L фандінг нижчий -> відкриваємо LONG (лонг отримує негативний фандінг).
 * Позиції однакового розміру => ціновий ризик нейтралізовано, заробляємо різницю ставок.
 *
 * Біржі мають різні інтервали виплат (1h / 4h / 8h), тому все нормалізуємо до ставки за годину.
 */

const base = (symbol) => symbol.split('/')[0];

/**
 * @param {Object<string, Object<string, {rate:number, intervalH:number, nextTs?:number, mark?:number}>>} ratesByExchange
 *        { binance: { 'BTC/USDT:USDT': {...} }, bybit: {...} }
 * @param {object} cfg
 * @param {(exId:string, symbol:string)=>number} takerFee
 */
function findOpportunities(ratesByExchange, cfg, takerFee = () => cfg.defaultTakerFee) {
  const bySymbol = new Map();
  for (const [exId, rates] of Object.entries(ratesByExchange)) {
    for (const [symbol, r] of Object.entries(rates)) {
      if (!Number.isFinite(r.rate) || Math.abs(r.rate) > cfg.maxAbsFundingRate) continue;
      if (cfg.whitelist.length && !cfg.whitelist.includes(base(symbol))) continue;
      if (cfg.blacklist.includes(base(symbol))) continue;
      if (!bySymbol.has(symbol)) bySymbol.set(symbol, []);
      bySymbol.get(symbol).push({ exId, ...r, hourly: r.rate / (r.intervalH || 8) });
    }
  }

  const now = Date.now();
  const opps = [];
  for (const [symbol, entries] of bySymbol) {
    if (entries.length < 2) continue;
    for (const s of entries) {
      for (const l of entries) {
        if (s.exId === l.exId) continue;
        const hourlyEdge = s.hourly - l.hourly;
        if (hourlyEdge <= 0) continue;
        const spread8h = hourlyEdge * 8;
        if (spread8h < cfg.minSpread8h) continue;

        // Орієнтовний basis за mark-цінами: шортимо дорожче, купуємо дешевше => позитивний basis в наш бік
        const basis = s.mark && l.mark ? (s.mark - l.mark) / l.mark : 0;
        if (basis < -cfg.maxEntryBasisPct) continue;

        // Вхід + вихід, дві ноги, тейкер
        const fees = 2 * (takerFee(s.exId, symbol) + takerFee(l.exId, symbol));
        const expectedFunding = hourlyEdge * cfg.holdHoursEstimate;
        const expectedProfit = expectedFunding - fees;
        if (expectedProfit < cfg.minExpectedProfitPct) continue;

        if (cfg.minMinutesToFunding > 0) {
          // Не заходимо, якщо до виплати на нозі з більшим вкладом залишилось замало часу:
          // ризик потрапити у виплату з протилежним знаком/зміною ставки.
          const nexts = [s.nextTs, l.nextTs].filter(Boolean);
          if (nexts.some((t) => t - now < cfg.minMinutesToFunding * 60000 && t > now)) continue;
        }

        opps.push({
          symbol,
          shortEx: s.exId,
          longEx: l.exId,
          shortRate: s.rate,
          longRate: l.rate,
          shortIntervalH: s.intervalH,
          longIntervalH: l.intervalH,
          hourlyEdge,
          spread8h,
          apr: hourlyEdge * 24 * 365,
          basis,
          fees,
          expectedProfit,
          shortNextTs: s.nextTs,
          longNextTs: l.nextTs,
        });
      }
    }
  }
  return opps.sort((a, b) => b.expectedProfit - a.expectedProfit);
}

/** Поточний спред для відкритої пари (за годину), або undefined якщо даних немає. */
function currentHourlyEdge(ratesByExchange, pos) {
  const s = ratesByExchange[pos.shortEx] && ratesByExchange[pos.shortEx][pos.symbol];
  const l = ratesByExchange[pos.longEx] && ratesByExchange[pos.longEx][pos.symbol];
  if (!s || !l) return undefined;
  return s.rate / (s.intervalH || 8) - l.rate / (l.intervalH || 8);
}

module.exports = { findOpportunities, currentHourlyEdge };
