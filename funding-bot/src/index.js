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
const { planWindows, dueWindows } = require('./scanner');
const { Trader } = require('./trader');
const { State } = require('./state');
const { Settings } = require('./settings');
const { Telegram } = require('./telegram');
const { KeyStore } = require('./keys');
const { CoinRegistry } = require('./coins');
const { formatDailyReport } = require('./report');
const { nowParts, clock, duration } = require('./time');

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

function printTable(wins, n) {
  if (!wins.length) {
    log.info('Вікон фандінгу, що проходять фільтри, немає');
    return;
  }
  const now = Date.now();
  console.table(
    wins.slice(0, n).map((w) => ({
      symbol: w.symbol,
      short: `${w.shortEx} ${pct(w.shortRate, 4)}/${w.shortIntervalH}h`,
      long: `${w.longEx} ${pct(w.longRate, 4)}/${w.longIntervalH}h`,
      'виплата': `${clock(w.startTs, cfg.timezone)}${w.endTs !== w.startTs ? `–${clock(w.endTs, cfg.timezone)}` : ''}`,
      'до старту': duration(w.startTs - now),
      'фандінг': pct(w.funding) + (w.estimated ? '≈' : ''),
      'чистий': pct(w.net),
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

  const keys = new KeyStore(cfg.credentials, cfg.keysFile);
  // all — усі налаштовані біржі (у т.ч. ті, що поки не підключились); exchanges — робочі
  const all = {};
  const exchanges = {};
  const initErrors = {};
  for (const id of cfg.exchanges) {
    try {
      all[id] = new Exchange(id, keys.get(id), { quote: cfg.quote, defaultTakerFee: cfg.defaultTakerFee });
    } catch (e) {
      initErrors[id] = e.message;
      log.error(`${id}: ${e.message}`);
    }
  }
  let lastInitTry = 0;
  let trader; // створюється нижче; initPending викликається і до, і після
  const initPending = async () => {
    lastInitTry = Date.now();
    await Promise.all(
      Object.values(all)
        .filter((ex) => !ex.ready)
        .map(async (ex) => {
          try {
            await ex.init();
            exchanges[ex.id] = ex;
            delete initErrors[ex.id];
            if (trader && trader.coins) trader.coins.load(ex).catch(() => {});
          } catch (e) {
            initErrors[ex.id] = e.message;
            log.error(`${ex.title}: підключення не вдалося: ${e.message}`);
          }
        })
    );
  };
  await initPending();
  if (Object.keys(exchanges).length < 2) throw new Error('Потрібно мінімум 2 робочі біржі');
  if (cfg.mode === 'live') {
    const withKeys = Object.values(exchanges).filter((e) => e.hasKeys).map((e) => e.id);
    log.info(`Торгівля між біржами з ключами: ${withKeys.join(', ') || 'немає'}; решта — лише дані`);
    if (withKeys.length < 2) log.warn('LIVE: потрібні ключі мінімум на 2 біржах (додайте у .env або /setkey у Telegram)');
  }

  trader = new Trader(cfg, exchanges, state, notify);
  const takerFee = (exId, symbol) => exchanges[exId].takerFee(symbol);

  // Перевірка монет: адреси контрактів з бірж (у фоні, оновлення раз на 6 год)
  const coins = new CoinRegistry(cfg, cfg.coinsFile);
  trader.coins = coins;
  let coinsLoadedAt = 0;
  const refreshCoins = () => {
    coinsLoadedAt = Date.now();
    coins.loadAll(exchanges).catch((e) => log.warn(`Адреси монет: ${e.message}`));
  };
  refreshCoins();
  const coinCheck = (coin, a, b, ma, mb) => coins.check(coin, a, b, ma, mb);

  let lastRates = {};
  let lastWindows = [];
  let lastScanAt;

  // Не шлемо звіт одразу після старту, якщо сьогоднішній час звіту вже минув
  if (!state.data.lastReportDay) {
    const { day, time } = nowParts(cfg.timezone);
    if (time >= cfg.reportTime) state.data.lastReportDay = day;
  }

  if (!scanOnly) {
    await tg.start({
      cfg, settings, state, trader, keys, all, exchanges, initErrors, coins,
      getRates: () => lastRates,
      getOpps: () => lastWindows,
      getLastScanAt: () => lastScanAt,
    });
    const qtyInfo =
      cfg.sizeMode === 'auto'
        ? `авто за стаканами, маржа до ${cfg.maxTradeUsdt} ${cfg.quote} × плече на кожній біржі`
        : cfg.sizeMode === 'coins'
        ? Object.keys(cfg.coinQty).length
          ? `монети: ${Object.entries(cfg.coinQty).map(([c, q]) => `${c} ${q}`).join(', ')}`
          : 'монети — ⚠️ не задано жодної, задайте /qty BTC 0.01'
        : `${cfg.positionUsdt} ${cfg.quote}`;
    await notify(
      `🚀 Бот запущено (${cfg.mode.toUpperCase()})${cfg.paused ? ' — ⏸ на паузі' : ''}\n` +
        `Біржі: ${Object.values(all).map((e) => `${e.ready ? '🟢' : '🔴'}${e.id}${e.hasKeys ? '🔑' : ''}`).join(' ')}\n` +
        `Вхід: ${qtyInfo}, плече x${cfg.leverage}, макс. пар ${cfg.maxPositions}\n` +
        `Поріг: фандінг > ${pct(cfg.minFunding)}, чистий > ${pct(cfg.minProfit)}\n` +
        `Вхід за ${cfg.entryBeforeSec} с до виплати, вихід через ${cfg.exitAfterSec} с після або при сходженні цін\n` +
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

  const scan = async () => {
    if (Object.keys(exchanges).length < Object.keys(all).length && Date.now() - lastInitTry > 5 * 60000) await initPending();
    const rates = await fetchAllRates(exchanges);
    if (Date.now() - coinsLoadedAt > 6 * 3600000) refreshCoins();
    let wins = planWindows(rates, cfg, takerFee, Date.now(), coinCheck);
    // У режимі монет торгуємо лише ті монети, для яких задано кількість
    if (cfg.sizeMode === 'coins') wins = wins.filter((w) => cfg.coinQty[coinOf(w.symbol)] > 0);
    lastRates = rates;
    lastWindows = wins;
    lastScanAt = Date.now();
    printTable(wins, cfg.topN);
  };

  let nextScan = 0;
  while (!stopping) {
    const started = Date.now();
    try {
      if (started >= nextScan) {
        nextScan = started + cfg.scanIntervalSec * 1000;
        await scan();
      }
      if (!scanOnly) {
        await trader.withLock(async () => {
          await trader.manage(lastRates);
          if (!cfg.paused) {
            // Вікна, до першої виплати яких лишилось ~entryBeforeSec. Найприбутковіші — першими.
            const due = dueWindows(lastWindows, cfg).sort((a, b) => b.net - a.net);
            for (const w of due) {
              if (state.positions.length >= cfg.maxPositions) break;
              await trader.tryOpen(w);
            }
          }
        });
        await maybeDailyReport(state, tg, lastRates);
      }
    } catch (e) {
      log.error('Помилка циклу:', e.message);
    }
    const wait = (scanOnly ? cfg.scanIntervalSec : cfg.tickSec) * 1000 - (Date.now() - started);
    for (let t = 0; t < wait && !stopping; t += 250) await sleep(Math.min(250, wait - t));
  }
  if (!scanOnly) await notify(`🛑 Бот зупинено. Відкритих позицій: ${state.positions.length} (залишаються на біржах)`);
}

main().catch((e) => {
  log.error(e.message);
  process.exit(1);
});
