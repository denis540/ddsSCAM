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
const { createNotifier } = require('./notifier');

const scanOnly = process.argv.includes('--scan-only');
const pct = (x, d = 3) => `${(x * 100).toFixed(d)}%`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  const rows = opps.slice(0, n).map((o) => ({
    symbol: o.symbol,
    short: `${o.shortEx} ${pct(o.shortRate, 4)}/${o.shortIntervalH}h`,
    long: `${o.longEx} ${pct(o.longRate, 4)}/${o.longIntervalH}h`,
    'spread/8h': pct(o.spread8h),
    APR: pct(o.apr, 1),
    basis: pct(o.basis),
    'net est.': pct(o.expectedProfit),
  }));
  console.table(rows);
}

async function main() {
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

  const state = new State(cfg.stateFile);
  const notify = createNotifier(cfg.telegram);
  const trader = new Trader(cfg, exchanges, state, notify);
  const takerFee = (exId, symbol) => exchanges[exId].takerFee(symbol);

  let stopping = false;
  const stop = () => {
    if (stopping) process.exit(1);
    stopping = true;
    log.info('Зупинка після поточного циклу (Ctrl+C ще раз — негайно). Відкриті позиції НЕ закриваються автоматично.');
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  if (state.positions.length) log.info(`Відновлено ${state.positions.length} відкритих позицій зі стану`);

  while (!stopping) {
    const started = Date.now();
    try {
      const rates = await fetchAllRates(exchanges);
      const opps = findOpportunities(rates, cfg, takerFee);
      printTable(opps, cfg.topN);

      if (!scanOnly) {
        trader.accrueFunding(rates);
        await trader.manage(rates);
        for (const opp of opps) {
          if (state.positions.length >= cfg.maxPositions) break;
          await trader.tryOpen(opp);
        }
        const s = state.data.stats;
        log.info(
          `Відкрито: ${state.positions.length}/${cfg.maxPositions} | ` +
            `реалізовано PnL: ${s.realizedPnl.toFixed(4)} | фандінг (закриті): ${s.fundingEarned.toFixed(4)} | ` +
            `фандінг (відкриті): ${state.positions.reduce((a, p) => a + p.fundingAccrued, 0).toFixed(4)} ${cfg.quote}`
        );
      }
    } catch (e) {
      log.error('Помилка циклу:', e.message);
    }
    const wait = cfg.scanIntervalSec * 1000 - (Date.now() - started);
    for (let t = 0; t < wait && !stopping; t += 500) await sleep(500);
  }
}

main().catch((e) => {
  log.error(e.message);
  process.exit(1);
});
