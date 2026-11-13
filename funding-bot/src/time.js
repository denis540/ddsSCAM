'use strict';

/** Дата (YYYY-MM-DD) і час (HH:MM) у заданому часовому поясі. */
function nowParts(timezone, ts = Date.now()) {
  const d = new Date(ts);
  const day = d.toLocaleDateString('sv-SE', { timeZone: timezone });
  const time = d.toLocaleTimeString('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hour12: false });
  return { day, time };
}

module.exports = { nowParts };
