'use strict';

/** Дата (YYYY-MM-DD) і час (HH:MM) у заданому часовому поясі. */
function nowParts(timezone, ts = Date.now()) {
  const d = new Date(ts);
  const day = d.toLocaleDateString('sv-SE', { timeZone: timezone });
  const time = d.toLocaleTimeString('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hour12: false });
  return { day, time };
}

module.exports = { nowParts };

/** HH:MM:SS у часовому поясі. */
function clock(ts, timezone) {
  return new Date(ts).toLocaleTimeString('en-GB', { timeZone: timezone, hour12: false });
}

/** «2 хв 05 с» / «1 год 58 хв» */
function duration(ms) {
  const neg = ms < 0;
  let s = Math.round(Math.abs(ms) / 1000);
  const h = Math.floor(s / 3600);
  s -= h * 3600;
  const m = Math.floor(s / 60);
  s -= m * 60;
  const txt = h ? `${h} год ${m} хв` : m ? `${m} хв ${String(s).padStart(2, '0')} с` : `${s} с`;
  return neg ? `−${txt}` : txt;
}

module.exports.clock = clock;
module.exports.duration = duration;

/**
 * Поправка годинника: різниця між часом бірж і локальним часом сервера.
 * Виплати фандінгу відбуваються за часом біржі, тож усі таймінги бот рахує за nowSynced().
 */
let clockOffsetMs = 0;
function setClockOffset(ms) {
  clockOffsetMs = Number.isFinite(ms) ? ms : 0;
}
function getClockOffset() {
  return clockOffsetMs;
}
function nowSynced() {
  return Date.now() + clockOffsetMs;
}

module.exports.setClockOffset = setClockOffset;
module.exports.getClockOffset = getClockOffset;
module.exports.nowSynced = nowSynced;
