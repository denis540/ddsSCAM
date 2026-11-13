'use strict';

const { clock, duration } = require('./time');
const { contrib } = require('./scanner');

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

function formatPosition(pos, rates, i, cfg) {
  const u = unrealized(pos, rates);
  const now = Date.now();
  const tz = cfg.timezone;
  const events = (pos.events || [])
    .map((e) => {
      const st = e.paid ? `✅ ${sign(e.amount)}` : `⏳ через ${duration(e.ts - now)}`;
      return `   ${clock(e.ts, tz)} ${e.ex} ${e.side.toUpperCase()} ${pct(e.rate, 4)}${e.est && !e.paid ? '≈' : ''} → ${sign(contrib(e) * 100, 4)}% ${st}`;
    })
    .join('\n');
  const exitTxt = pos.exitAt ? (pos.exitAt > now ? `вихід ~${clock(pos.exitAt, tz)} (через ${duration(pos.exitAt - now)}) або при сходженні цін` : 'виходимо…') : '';
  return (
    `${i}. ${pos.symbol} — ${fmt(pos.base, 8)} ${pos.symbol.split('/')[0]}, x${pos.leverage || '?'}\n` +
    `   SHORT ${pos.shortEx} @ ${fmt(pos.short.entry, 8)} | LONG ${pos.longEx} @ ${fmt(pos.long.entry, 8)}\n` +
    `${events}\n` +
    `   Фандінг ${sign(pos.fundingAccrued)} (очік. ${sign((pos.expectedFunding || 0) * 100, 4)}%), комісії −${fmt(pos.feesPaid)}, ціна ${sign(u.price)}\n` +
    `   Нереаліз. PnL: ${sign(u.total)} ${cfg.quote}\n   ${exitTxt}` +
    (pos.closeError ? '\n   ⚠️ закрита не повністю!' : '')
  );
}

function formatPositions(state, rates, cfg) {
  if (!state.positions.length) return 'Відкритих позицій немає';
  return state.positions.map((p, i) => formatPosition(p, rates, i + 1, cfg)).join('\n\n');
}

function formatOpps(wins, cfg, n = 10, exchanges = {}, caps = {}) {
  if (!wins || !wins.length) return 'Вікон фандінгу, що проходять фільтри, зараз немає';
  const now = Date.now();
  const tz = cfg.timezone;
  return (
    `Найкращі вікна (вхід за ${cfg.entryBeforeSec} с до першої виплати):\n\n` +
    wins
      .slice(0, n)
      .map((w, i) => {
        const ev = w.events
          .map((e) => `   ${clock(e.ts, tz)} ${e.ex} ${e.side.toUpperCase()} ${pct(e.rate, 4)}${e.est ? '≈' : ''} → ${sign(contrib(e) * 100, 4)}%`)
          .join('\n');
        const noKeys = cfg.mode === 'live' && [w.shortEx, w.longEx].filter((id) => exchanges[id] && !exchanges[id].hasKeys);
        const keysTxt = noKeys && noKeys.length ? `\n   ⚠️ немає ключа: ${noKeys.join(', ')} — торгівлі не буде` : '';
        return (
          `${i + 1}. ${w.symbol}: SHORT ${w.shortEx} / LONG ${w.longEx}, старт через ${duration(w.startTs - now)}${keysTxt}\n${ev}\n` +
          `   фандінг ${pct(w.funding)}${w.estimated ? ' (частково оцінка)' : ''}, комісії ${pct(w.fees)}, чистий ${pct(w.net)}` +
          (caps[i] ? `\n   💧 зайти зараз можна на ≈ ${fmt(caps[i].base * caps[i].mid, 0)} ${cfg.quote} (обмежує: ${caps[i].limitedBy})` : '')
        );
      })
      .join('\n\n')
  );
}

function formatStatus(cfg, state, rates, lastScanAt) {
  const s = state.data.stats;
  const today = state.day();
  const openU = state.positions.reduce((a, p) => a + unrealized(p, rates).total, 0);
  return (
    `🤖 Режим: ${cfg.mode.toUpperCase()}${cfg.paused ? ' — ⏸ ПАУЗА (нові входи вимкнено)' : ''}\n` +
    `Біржі: ${cfg.exchanges.join(', ')}\n` +
    `Розмір: ${cfg.sizeMode === 'auto' ? `авто за стаканами, маржа до ${cfg.maxTradeUsdt} ${cfg.quote} × плече на кожній біржі (мін. позиція ${cfg.minTradeUsdt})` : cfg.sizeMode === 'coins' ? `монети (${Object.keys(cfg.coinQty).length} налаштовано, /qty)` : `${cfg.positionUsdt} ${cfg.quote}`}, плече x${cfg.leverage}\n` +
    `Поріг: фандінг > ${pct(cfg.minFunding)}, чистий > ${pct(cfg.minProfit)}\n` +
    `Вхід за ${cfg.entryBeforeSec} с до виплати, вихід через ${cfg.exitAfterSec} с після / при сходженні (≤${pct(cfg.convergePct)})\n` +
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

module.exports = { formatPositions, formatOpps, formatStatus, formatDailyReport, formatHistory, unrealized, pct, fmt, sign };
