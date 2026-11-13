'use strict';

const log = require('./logger');

let cfg;
try {
  cfg = require('./config');
} catch (e) {
  log.error(`Помилка конфігурації: ${e.message}`);
  process.exit(1);
}
const { Exchange } = require('./exchange');
const { findOpportunities } = require('./scanner');
const { Trader } = require('./trader');
const { State } = require('./state');
const { Settings } = require('./settings');
const { Telegram } = require('./telegram');
const { formatDailyReport } = require('./report');
const { nowParts } = require('./time');

const scanOnly = process.argv.includes('--scan-only');
const pct = (x, d = 3) => `${(x * 100).toFixed(d)}%`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const coinOf = (symbol) => symbol.split('/')[0];

async function fetchAllRates(exchanges) {
  const entries = await Promise.all(
    Object.values(exchanges).map(async (ex) => {
      try {
        return [ex.id, await ex.fetchFundingRates()];
      } catch (e) {
        log.warn(`${ex.id}: не вдалося отримати фандінг: ${e.message}`);
        return [ex.id, {}];
      }
    })
  );
  return Object.fromEntries(entries);
}

function printTable(opps, n) {
  if (!opps.length) {
    log.info('Можливостей, що проходять фільтри, немає');
    return;
  }
  console.table(
    opps.slice(0, n).map((o) => ({
      symbol: o.symbol,
      short: `${o.shortEx} ${pct(o.shortRate, 4)}/${o.shortIntervalH}h`,
      long: `${o.longEx} ${pct(o.longRate, 4)}/${o.longIntervalH}h`,
      'spread/8h': pct(o.spread8h),
      APR: pct(o.apr, 1),
      basis: pct(o.basis),
      'net est.': pct(o.expectedProfit),
    }))
  );
}

/** Надсилає щоденний звіт один раз на день після reportTime. */
async function maybeDailyReport(state, tg, rates) {
  const { day, time } = nowParts(cfg.timezone);
  if (time < cfg.reportTime || state.data.lastReportDay === day) return;
  state.data.lastReportDay = day;
  state.save();
  await tg.send(formatDailyReport(cfg, state, day, rates));
}

async function main() {
  const state = new State(cfg.stateFile, cfg.timezone);
  const settings = new Settings(cfg, cfg.settingsFile);
  const tg = new Telegram(cfg.telegram);
  const notify = (t) => tg.send(t);

  log.info(`Старт. Режим: ${cfg.mode.toUpperCase()}${scanOnly ? ' (тільки сканування)' : ''}. Біржі: ${cfg.exchanges.join(', ')}`);
  if (cfg.mode === 'live') log.warn('LIVE-режим: бот виставлятиме реальні ордери!');

  const exchanges = {};
  for (const id of cfg.exchanges) {
    try {
      const ex = new Exchange(id, cfg.credentials[id], { quote: cfg.quote, defaultTakerFee: cfg.defaultTakerFee });
      await ex.init();
      exchanges[id] = ex;
    } catch (e) {
      log.error(`${id}: ініціалізація не вдалася: ${e.message}`);
    }
  }
  if (Object.keys(exchanges).length < 2) throw new Error('Потрібно мінімум 2 робочі біржі');

  const trader = new Trader(cfg, exchanges, state, notify);
  const takerFee = (exId, symbol) => exchanges[exId].takerFee(symbol);

  let lastRates = {};
  let lastOpps = [];
  let lastScanAt;

  // Не шлемо звіт одразу після старту, якщо сьогоднішній час звіту вже минув
  if (!state.data.lastReportDay) {
    const { day, time } = nowParts(cfg.timezone);
    if (time >= cfg.reportTime) state.data.lastReportDay = day;
  }

  if (!scanOnly) {
    await tg.start({
      cfg, settings, state, trader,
      getRates: () => lastRates,
      getOpps: () => lastOpps,
      getLastScanAt: () => lastScanAt,
    });
    const qtyInfo =
      cfg.sizeMode === 'coins'
        ? Object.keys(cfg.coinQty).length
          ? `монети: ${Object.entries(cfg.coinQty).map(([c, q]) => `${c} ${q}`).join(', ')}`
          : 'монети — ⚠️ не задано жодної, задайте /qty BTC 0.01'
        : `${cfg.positionUsdt} ${cfg.quote}`;
    await notify(
      `🚀 Бот запущено (${cfg.mode.toUpperCase()})${cfg.paused ? ' — ⏸ на паузі' : ''}\n` +
        `Біржі: ${Object.keys(exchanges).join(', ')}\n` +
        `Вхід: ${qtyInfo}, плече x${cfg.leverage}, макс. пар ${cfg.maxPositions}\n` +
        `Поріг: спред > ${pct(cfg.minSpread8h)}/8h\n` +
        `Відкритих позицій: ${state.positions.length}\n/help — команди`
    );
  }

  let stopping = false;
  const stop = () => {
    if (stopping) process.exit(1);
    stopping = true;
    tg.stopped = true;
    log.info('Зупинка після поточного циклу (Ctrl+C ще раз — негайно). Відкриті позиції НЕ закриваються автоматично.');
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  while (!stopping) {
    const started = Date.now();
    try {
      const rates = await fetchAllRates(exchanges);
      let opps = findOpportunities(rates, cfg, takerFee);
      // У режимі монет торгуємо лише ті монети, для яких задано кількість
      if (cfg.sizeMode === 'coins') opps = opps.filter((o) => cfg.coinQty[coinOf(o.symbol)] > 0);
      lastRates = rates;
      lastOpps = opps;
      lastScanAt = Date.now();
      printTable(opps, cfg.topN);

      if (!scanOnly) {
        await trader.withLock(async () => {
          trader.accrueFunding(rates);
          await trader.manage(rates);
          if (!cfg.paused) {
            for (const opp of opps) {
              if (state.positions.length >= cfg.maxPositions) break;
              await trader.tryOpen(opp);
            }
          }
        });
        await maybeDailyReport(state, tg, rates);
      }
    } catch (e) {
      log.error('Помилка циклу:', e.message);
    }
    const wait = cfg.scanIntervalSec * 1000 - (Date.now() - started);
    for (let t = 0; t < wait && !stopping; t += 500) await sleep(500);
  }
  if (!scanOnly) await notify(`🛑 Бот зупинено. Відкритих позицій: ${state.positions.length} (залишаються на біржах)`);
}

main().catch((e) => {
  log.error(e.message);
  process.exit(1);
});
