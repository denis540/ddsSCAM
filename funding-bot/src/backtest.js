'use strict';

const log = require('./logger');

/**
 * Перевірка стратегії на історії ставок фандінгу.
 *
 * Для кожної монети й кожного моменту виплати (на будь-якій біржі) береться найкраща пара бірж:
 * SHORT отримує свою ставку, якщо в цей момент на його біржі виплата, LONG платить свою (або отримує при від'ємній).
 * Це покриває виплати в один час і виплату лише на одній біржі. Далі ті самі фільтри, що й у бота:
 * фандінг ≥ minFunding, чистий після 4 комісій ≥ minProfit, не більше maxPositions угод одночасно.
 *
 * Обмеження (тому результат — оцінка «зверху»): історії цін між біржами (basis), проковзування і глибини
 * стакану тут немає; вікна, що тягнуться між виплатами різних бірж, не враховуються.
 */

const MIN = 60000;
const roundMin = (ts) => Math.round(ts / MIN) * MIN;

function pickCoins(exchanges, cfg, maxCoins) {
  const count = {};
  const vol = {};
  for (const ex of Object.values(exchanges)) {
    for (const sym of ex.perpSymbols()) {
      count[sym] = (count[sym] || 0) + 1;
      vol[sym] = (vol[sym] || 0) + ((ex.tickers[sym] && ex.tickers[sym].volumeUsdt) || 0);
    }
  }
  let syms = Object.keys(count).filter((s) => count[s] >= 2);
  const coin = (s) => s.split('/')[0];
  const fixed = cfg.whitelist.length ? cfg.whitelist : cfg.sizeMode === 'coins' ? Object.keys(cfg.coinQty) : [];
  if (fixed.length) syms = syms.filter((s) => fixed.includes(coin(s)));
  syms = syms.filter((s) => !cfg.blacklist.includes(coin(s)));
  return syms.sort((a, b) => vol[b] - vol[a]).slice(0, maxCoins);
}

/**
 * @returns {Promise<object>} статистика; text — готовий звіт
 */
async function runBacktest({ exchanges, cfg, days = 7, maxCoins = 25, now = Date.now(), onProgress }) {
  const since = now - days * 86400000;
  const symbols = pickCoins(exchanges, cfg, maxCoins);
  const notional = cfg.sizeMode === 'auto' ? cfg.maxTradeUsdt * cfg.leverage : cfg.positionUsdt;
  const candidates = []; // { ts, symbol, shortEx, longEx, funding, net }
  let done = 0;

  for (const symbol of symbols) {
    const hist = {}; // exId -> { map ts->rate, from, to }
    await Promise.all(
      Object.values(exchanges)
        .filter((ex) => ex.native[symbol])
        .map(async (ex) => {
          try {
            const rows = await ex.fundingRateHistory(symbol, since, now);
            if (rows.length) hist[ex.id] = { map: new Map(rows.map((r) => [roundMin(r.ts), r.rate])), from: roundMin(rows[0].ts), to: roundMin(rows[rows.length - 1].ts) };
          } catch (e) {
            log.debug(`backtest ${ex.id} ${symbol}: ${e.message}`);
          }
        })
    );
    const ids = Object.keys(hist);
    if (ids.length >= 2) {
      const times = new Set();
      for (const id of ids) for (const t of hist[id].map.keys()) times.add(t);
      for (const t of times) {
        let best;
        for (const S of ids) {
          for (const L of ids) {
            if (S === L) continue;
            const hs = hist[S];
            const hl = hist[L];
            // обидві біржі мали цю монету в цей час
            if (t < hs.from || t > hs.to + 8 * 3600000 || t < hl.from || t > hl.to + 8 * 3600000) continue;
            const rs = hs.map.get(t);
            const rl = hl.map.get(t);
            if (rs === undefined && rl === undefined) continue;
            const funding = (rs || 0) - (rl || 0);
            if (Math.abs(rs || 0) > cfg.maxAbsFundingRate || Math.abs(rl || 0) > cfg.maxAbsFundingRate) continue;
            const fees = 2 * (exchanges[S].takerFee(symbol) + exchanges[L].takerFee(symbol));
            const net = funding - fees;
            if (!best || net > best.net) best = { ts: t, symbol, shortEx: S, longEx: L, funding, net };
          }
        }
        if (best && best.funding >= cfg.minFunding && best.net >= cfg.minProfit) candidates.push(best);
      }
    }
    done += 1;
    if (onProgress) await onProgress(done, symbols.length);
  }

  // не більше maxPositions угод в один момент — беремо найприбутковіші
  const byTime = new Map();
  for (const c of candidates) (byTime.get(c.ts) || byTime.set(c.ts, []).get(c.ts)).push(c);
  const trades = [];
  for (const list of byTime.values()) trades.push(...list.sort((a, b) => b.net - a.net).slice(0, cfg.maxPositions));
  trades.sort((a, b) => a.ts - b.ts);

  const sumNet = trades.reduce((a, t) => a + t.net, 0);
  const usdt = sumNet * notional;
  const group = (key) => {
    const m = {};
    for (const t of trades) {
      const k = key(t);
      m[k] = m[k] || { n: 0, net: 0 };
      m[k].n += 1;
      m[k].net += t.net;
    }
    return Object.entries(m).sort((a, b) => b[1].net - a[1].net);
  };
  const pairs = group((t) => `${t.shortEx}→${t.longEx}`).slice(0, 8);
  const coins = group((t) => t.symbol.split('/')[0]).slice(0, 10);
  const pct = (x, d = 2) => `${(x * 100).toFixed(d)}%`;
  const text =
    `📈 Перевірка на історії: ${days} дн, ${symbols.length} монет, біржі: ${Object.keys(exchanges).join(', ')}\n` +
    `Пороги: фандінг ≥ ${pct(cfg.minFunding)}, чистий ≥ ${pct(cfg.minProfit)}, макс. ${cfg.maxPositions} угод одночасно\n\n` +
    `Угод: ${trades.length} (≈ ${(trades.length / days).toFixed(1)} на день)\n` +
    `Сумарно чистими: ${pct(sumNet)} від позиції\n` +
    `При позиції ${notional} ${cfg.quote}: ≈ ${usdt >= 0 ? '+' : ''}${usdt.toFixed(2)} ${cfg.quote} (≈ ${(usdt / days).toFixed(2)} на день)\n` +
    (trades.length ? `Середня угода: ${pct(sumNet / trades.length, 3)}, найкраща: ${pct(Math.max(...trades.map((t) => t.net)), 3)}\n` : '') +
    (pairs.length ? `\nНайкращі пари бірж:\n${pairs.map(([k, v]) => `   ${k}: ${v.n} угод, ${pct(v.net)}`).join('\n')}\n` : '') +
    (coins.length ? `\nНайкращі монети:\n${coins.map(([k, v]) => `   ${k}: ${v.n} угод, ${pct(v.net)}`).join('\n')}\n` : '') +
    '\n⚠️ Це оцінка «зверху»: різниці цін між біржами, проковзування і глибини стакану в історії немає. ' +
    'Реальний результат буде нижчим — порівнюйте з PAPER-режимом.';
  return { trades, symbols, sumNet, usdt, notional, text };
}

module.exports = { runBacktest, pickCoins };
