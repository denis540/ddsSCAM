'use strict';

const pct = (x, d = 3) => (Number.isFinite(x) ? `${(x * 100).toFixed(d)}%` : '—');
const fmt = (x, d = 4) => (Number.isFinite(x) ? (+x.toFixed(d)).toString() : '—');
const sign = (x, d = 4) => (Number.isFinite(x) ? `${x >= 0 ? '+' : ''}${fmt(x, d)}` : '—');

/** Оцінка нереалізованого PnL відкритої пари за поточними mark-цінами. */
function unrealized(pos, rates) {
  const markS = rates?.[pos.shortEx]?.[pos.symbol]?.mark;
  const markL = rates?.[pos.longEx]?.[pos.symbol]?.mark;
  const price = markS && markL ? (pos.short.entry - markS) * pos.base + (markL - pos.long.entry) * pos.base : undefined;
  return { price, total: (price ?? 0) + pos.fundingAccrued - pos.feesPaid, hasPrice: price !== undefined };
}

function currentSpread8h(pos, rates) {
  const s = rates?.[pos.shortEx]?.[pos.symbol];
  const l = rates?.[pos.longEx]?.[pos.symbol];
  if (!s || !l) return undefined;
  return (s.rate / (s.intervalH || 8) - l.rate / (l.intervalH || 8)) * 8;
}

function formatPosition(pos, rates, i, quote) {
  const u = unrealized(pos, rates);
  const heldH = (Date.now() - pos.openedAt) / 3600000;
  return (
    `${i}. ${pos.symbol} — ${fmt(pos.base, 8)} ${pos.symbol.split('/')[0]}, x${pos.leverage || '?'}\n` +
    `   SHORT ${pos.shortEx} @ ${fmt(pos.short.entry, 8)} | LONG ${pos.longEx} @ ${fmt(pos.long.entry, 8)}\n` +
    `   Спред: вхід ${pct(pos.entrySpread8h)} → зараз ${pct(currentSpread8h(pos, rates))} /8h | ${heldH.toFixed(1)} год\n` +
    `   Фандінг ${sign(pos.fundingAccrued)}, комісії −${fmt(pos.feesPaid)}, ціна ${sign(u.price)}\n` +
    `   Нереаліз. PnL: ${sign(u.total)} ${quote}` +
    (pos.closeError ? '\n   ⚠️ закрита не повністю!' : '')
  );
}

function formatPositions(state, rates, quote) {
  if (!state.positions.length) return 'Відкритих позицій немає';
  return state.positions.map((p, i) => formatPosition(p, rates, i + 1, quote)).join('\n\n');
}

function formatOpps(opps, n = 10) {
  if (!opps || !opps.length) return 'Можливостей, що проходять фільтри, зараз немає';
  return opps
    .slice(0, n)
    .map(
      (o, i) =>
        `${i + 1}. ${o.symbol}: SHORT ${o.shortEx} ${pct(o.shortRate, 4)}/${o.shortIntervalH}h | LONG ${o.longEx} ${pct(o.longRate, 4)}/${o.longIntervalH}h\n` +
        `   спред ${pct(o.spread8h)}/8h, APR ${pct(o.apr, 1)}, чистий за горизонт ${pct(o.expectedProfit)}`
    )
    .join('\n');
}

function formatStatus(cfg, state, rates, lastScanAt) {
  const s = state.data.stats;
  const today = state.day();
  const openU = state.positions.reduce((a, p) => a + unrealized(p, rates).total, 0);
  return (
    `🤖 Режим: ${cfg.mode.toUpperCase()}${cfg.paused ? ' — ⏸ ПАУЗА (нові входи вимкнено)' : ''}\n` +
    `Біржі: ${cfg.exchanges.join(', ')}\n` +
    `Розмір: ${cfg.sizeMode === 'coins' ? `монети (${Object.keys(cfg.coinQty).length} налаштовано, /qty)` : `${cfg.positionUsdt} ${cfg.quote}`}, плече x${cfg.leverage}\n` +
    `Поріг входу: спред > ${pct(cfg.minSpread8h)}/8h\n` +
    `Позиції: ${state.positions.length}/${cfg.maxPositions}, нереаліз. PnL ${sign(openU)} ${cfg.quote}\n\n` +
    `Сьогодні: PnL ${sign(today.pnl)}, фандінг ${sign(today.funding)}, угод закрито ${today.closed}\n` +
    `Всього: PnL ${sign(s.realizedPnl)} ${cfg.quote}, угод ${s.trades} (прибуткових ${s.wins})\n` +
    `Останній скан: ${lastScanAt ? `${Math.round((Date.now() - lastScanAt) / 1000)} с тому` : '—'}`
  );
}

function formatDailyReport(cfg, state, dayKey, rates) {
  const d = state.data.daily[dayKey] || { opened: 0, closed: 0, pnl: 0, funding: 0, fees: 0 };
  const s = state.data.stats;
  const closed = state.closedOn(dayKey);
  const lines = closed.map(
    (c) => `• ${c.symbol} ${c.shortEx}/${c.longEx}, ${fmt(c.base, 8)} шт: ${sign(c.pnl)} (фандінг ${sign(c.fundingAccrued)})`
  );
  const openU = state.positions.reduce((a, p) => a + unrealized(p, rates).total, 0);
  return (
    `📅 Звіт за ${dayKey}${cfg.mode === 'live' ? '' : ' [PAPER]'}\n\n` +
    `Відкрито пар: ${d.opened}, закрито: ${d.closed}\n` +
    (lines.length ? `${lines.join('\n')}\n` : '') +
    `\nРеалізований PnL за день: ${sign(d.pnl)} ${cfg.quote}\n` +
    `Фандінг нараховано за день (усі позиції): ${sign(d.funding)}\n` +
    `Комісії за день: −${fmt(d.fees)}\n\n` +
    `Відкритих зараз: ${state.positions.length}, нереаліз. PnL ${sign(openU)}\n` +
    `💼 ЗАГАЛЬНИЙ PnL: ${sign(s.realizedPnl)} ${cfg.quote} (${s.trades} угод, фандінг ${sign(s.fundingEarned)}, комісії −${fmt(s.feesPaid)})`
  );
}

function formatHistory(state, n = 10, quote = 'USDT') {
  const c = state.data.closed.slice(-n).reverse();
  if (!c.length) return 'Закритих угод ще немає';
  return c
    .map(
      (x) =>
        `${new Date(x.closedAt).toISOString().slice(5, 16).replace('T', ' ')} ${x.symbol} ${x.shortEx}/${x.longEx} ` +
        `${fmt(x.base, 8)} шт: ${sign(x.pnl)} ${quote}\n   ${x.reason}`
    )
    .join('\n');
}

module.exports = { formatPositions, formatOpps, formatStatus, formatDailyReport, formatHistory, unrealized };
