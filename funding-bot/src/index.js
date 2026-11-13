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
const { Guard } = require('./guard');
const { Reconciler } = require('./reconcile');
const { formatDailyReport } = require('./report');
const { nowParts, clock, duration, nowSynced, setClockOffset } = require('./time');

const scanOnly = process.argv.includes('--scan-only');
const pct = (x, d = 3) => `${(x * 100).toFixed(d)}%`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const coinOf = (symbol) => symbol.split('/')[0];
const MIN = 60000;
const HOUR = 3600000;

function printTable(wins, n) {
  if (!wins.length) {
    log.info('Вікон фандінгу, що проходять фільтри, немає');
    return;
  }
  const now = nowSynced();
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

async function main() {
  const state = new State(cfg.stateFile, cfg.timezone);
  const settings = new Settings(cfg, cfg.settingsFile);
  const tg = new Telegram(cfg.telegram);
  const notify = (t, markup) => tg.send(t, undefined, markup);

  // Будь-яка неперехоплена помилка — у лог і в Telegram. Критична — перезапуск процесу (pm2/systemd підніме).
  process.on('unhandledRejection', (e) => {
    log.error('unhandledRejection:', e && e.stack ? e.stack : e);
    notify(`⚠️ Внутрішня помилка: ${(e && e.message) || e}`).catch(() => {});
  });
  process.on('uncaughtException', (e) => {
    log.error('uncaughtException:', e && e.stack ? e.stack : e);
    notify(`🚨 Критична помилка, бот перезапускається: ${e && e.message}`)
      .catch(() => {})
      .finally(() => setTimeout(() => process.exit(1), 1000));
  });

  log.info(`Старт. Режим: ${cfg.mode.toUpperCase()}${cfg.sandbox ? ' (ТЕСТОВІ МЕРЕЖІ)' : ''}${scanOnly ? ' (тільки сканування)' : ''}. Біржі: ${cfg.exchanges.join(', ')}`);
  if (cfg.mode === 'live' && !cfg.sandbox) log.warn('LIVE-режим: бот виставлятиме реальні ордери!');

  const keys = new KeyStore(cfg.credentials, cfg.keysFile);
  // all — усі налаштовані біржі (у т.ч. ті, що поки не підключились); exchanges — робочі
  const all = {};
  const exchanges = {};
  const initErrors = {};
  for (const id of cfg.exchanges) {
    try {
      const ex = new Exchange(id, keys.get(id), { quote: cfg.quote, defaultTakerFee: cfg.defaultTakerFee });
      if (cfg.sandbox && !ex.enableSandbox()) {
        log.warn(`${ex.title}: тестової мережі немає — у режимі SANDBOX біржу вимкнено`);
        initErrors[id] = 'немає тестової мережі (SANDBOX)';
        continue;
      }
      all[id] = ex;
    } catch (e) {
      initErrors[id] = e.message;
      log.error(`${id}: ${e.message}`);
    }
  }

  let lastInitTry = 0;
  let trader; // створюється нижче; initPending викликається і до, і після
  const blockedNotified = new Set();
  /** Live: біржа має бути в one-way режимі позицій, інакше торгівлю на ній блокуємо. */
  const checkPositionMode = async (ex) => {
    if (cfg.mode !== 'live' || !ex.hasKeys) return;
    ex.tradeBlocked = await ex.ensureOneWay();
    if (ex.tradeBlocked && !blockedNotified.has(ex.id)) {
      blockedNotified.add(ex.id);
      await notify(`⛔ ${ex.title}: торгівлю на біржі заблоковано — ${ex.tradeBlocked}`);
    }
    if (!ex.tradeBlocked) blockedNotified.delete(ex.id);
  };
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
            await checkPositionMode(ex);
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
  const guard = new Guard(cfg, state, settings, notify);
  trader.guard = guard;
  const reconciler = new Reconciler(cfg, state, exchanges, trader, notify);
  const takerFee = (exId, symbol) => exchanges[exId].takerFee(symbol);

  // ---- Годинник: синхронізація з біржами (виплати — за їхнім часом) ----
  let clockSyncedAt = 0;
  let skewWarnedAt = 0;
  const syncClock = async () => {
    clockSyncedAt = Date.now();
    const offs = (
      await Promise.all(Object.values(exchanges).map((ex) => ex.clockOffset().catch(() => undefined)))
    ).filter(Number.isFinite).sort((a, b) => a - b);
    if (!offs.length) return;
    const median = offs[Math.floor(offs.length / 2)];
    setClockOffset(median);
    log.info(`Годинник: різниця з біржами ${Math.round(median)} мс (поправку застосовано)`);
    if (Math.abs(median) > cfg.maxClockSkewMs && Date.now() - skewWarnedAt > 6 * HOUR) {
      skewWarnedAt = Date.now();
      await notify(`⏰ Годинник сервера розходиться з біржами на ${(median / 1000).toFixed(1)} с. Бот враховує поправку, але краще увімкнути синхронізацію часу (NTP) на сервері.`);
    }
  };
  await syncClock();

  // ---- Перевірка монет: адреси контрактів + ризики ринку + обсяги ----
  const coins = new CoinRegistry(cfg, cfg.coinsFile);
  trader.coins = coins;
  let coinsLoadedAt = 0;
  const refreshCoins = () => {
    coinsLoadedAt = Date.now();
    coins.loadAll(exchanges).catch((e) => log.warn(`Адреси монет: ${e.message}`));
  };
  refreshCoins();
  let tickersAt = 0;
  const refreshTickers = async () => {
    tickersAt = Date.now();
    await Promise.all(Object.values(exchanges).map((ex) => ex.loadTickers().catch((e) => log.debug(`${ex.id} tickers: ${e.message}`))));
  };
  await refreshTickers();
  /** Ризики ринку на одній біржі: новий лістинг, делістинг, статус, малий обсяг. */
  const marketProblem = (coin, exId) => {
    const ex = exchanges[exId];
    const sym = `${coin}/USDT:USDT`;
    const risk = ex.marketRisk(sym, cfg, nowSynced());
    if (risk) return `${exId}: ${risk}`;
    const v = ex.tickers[sym] && ex.tickers[sym].volumeUsdt;
    if (cfg.minVolumeUsdt > 0 && v !== undefined && v < cfg.minVolumeUsdt) return `${exId}: малий обсяг за 24 год (${Math.round(v).toLocaleString('uk-UA')} USDT)`;
    return undefined;
  };
  const coinCheck = (coin, a, b, ma, mb) => {
    const p = marketProblem(coin, a) || marketProblem(coin, b);
    if (p) return { ok: false, status: 'market', reason: p };
    return coins.check(coin, a, b, ma, mb);
  };

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
      cfg, settings, state, trader, keys, all, exchanges, initErrors, coins, guard, reconciler, marketProblem,
      checkPositionMode,
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
      `🚀 Бот запущено (${cfg.mode.toUpperCase()}${cfg.sandbox ? ', ТЕСТОВІ МЕРЕЖІ' : ''})${cfg.paused ? ' — ⏸ на паузі' : ''}\n` +
        `Біржі: ${Object.values(all).map((e) => `${e.ready ? (e.tradeBlocked ? '⛔' : '🟢') : '🔴'}${e.id}${e.hasKeys ? '🔑' : ''}`).join(' ')}\n` +
        `Вхід: ${qtyInfo}, плече x${cfg.leverage}, макс. пар ${cfg.maxPositions}\n` +
        `Поріг: фандінг > ${pct(cfg.minFunding)}, чистий > ${pct(cfg.minProfit)}\n` +
        `Захист: стопи на біржах ${cfg.protectStops ? 'on' : 'off'}, закриття при ${pct(cfg.liqClosePct, 0)} шляху до ліквідації, ` +
        `макс. збиток за день ${cfg.maxDailyLossUsdt || '—'}\n` +
        `Відкритих позицій: ${state.positions.length}\n/help — команди`
    );
  }

  // ---- Звірка з біржами: одразу після старту (знайде непарні ноги після збою) і далі періодично ----
  let reconciledAt = 0;
  const reconcile = async () => {
    reconciledAt = Date.now();
    try {
      await trader.withLock(() => reconciler.run());
    } catch (e) {
      log.warn(`Звірка: ${e.message}`);
    }
  };
  if (!scanOnly) await reconcile();

  let stopping = false;
  const stop = () => {
    if (stopping) process.exit(1);
    stopping = true;
    tg.stopped = true;
    log.info('Зупинка після поточного циклу (Ctrl+C ще раз — негайно). Відкриті позиції НЕ закриваються автоматично.');
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  // ---- Нагляд за біржами: повідомлення, якщо біржа довго не відповідає ----
  const failCount = {};
  const downNotified = new Set();
  const fetchAllRates = async () => {
    const entries = await Promise.all(
      Object.values(exchanges).map(async (ex) => {
        try {
          const r = await ex.fetchFundingRates();
          if (downNotified.has(ex.id)) {
            downNotified.delete(ex.id);
            notify(`✅ ${ex.title} знову відповідає`).catch(() => {});
          }
          failCount[ex.id] = 0;
          return [ex.id, r];
        } catch (e) {
          failCount[ex.id] = (failCount[ex.id] || 0) + 1;
          log.warn(`${ex.id}: не вдалося отримати фандінг (${failCount[ex.id]} поспіль): ${e.message}`);
          if (failCount[ex.id] >= 3 && !downNotified.has(ex.id)) {
            downNotified.add(ex.id);
            const open = state.positions.filter((p) => p.shortEx === ex.id || p.longEx === ex.id).map((p) => coinOf(p.symbol));
            notify(
              `📡 ${ex.title} не відповідає вже ~${Math.round((failCount[ex.id] * cfg.scanIntervalSec) / 60) || 1} хв: ${e.message.slice(0, 120)}` +
                (open.length ? `\n⚠️ На ній відкриті позиції: ${open.join(', ')}. Стопи на біржі стоять; бот закриє, щойно зв'язок відновиться.` : '')
            ).catch(() => {});
          }
          return [ex.id, {}];
        }
      })
    );
    return Object.fromEntries(entries);
  };

  const scan = async () => {
    if (Object.keys(exchanges).length < Object.keys(all).length && Date.now() - lastInitTry > 5 * MIN) await initPending();
    if (Date.now() - tickersAt > 5 * MIN) await refreshTickers();
    if (Date.now() - coinsLoadedAt > 6 * HOUR) refreshCoins();
    if (Date.now() - clockSyncedAt > HOUR) await syncClock();
    const rates = await fetchAllRates();
    let wins = planWindows(rates, cfg, takerFee, nowSynced(), coinCheck);
    // У режимі монет торгуємо лише ті монети, для яких задано кількість
    if (cfg.sizeMode === 'coins') wins = wins.filter((w) => cfg.coinQty[coinOf(w.symbol)] > 0);
    lastRates = rates;
    lastWindows = wins;
    lastScanAt = Date.now();
    printTable(wins, cfg.topN);
  };

  // ---- Пульс: «я працюю» в Telegram ----
  let heartbeatAt = Date.now();
  const heartbeat = async () => {
    if (!(cfg.heartbeatHours > 0) || Date.now() - heartbeatAt < cfg.heartbeatHours * HOUR) return;
    heartbeatAt = Date.now();
    const day = state.day();
    const ok = Object.values(all).filter((e) => e.ready && !downNotified.has(e.id)).length;
    await notify(
      `💓 Працюю. Біржі на зв'язку: ${ok}/${Object.keys(all).length}. Позицій: ${state.positions.length}.\n` +
        `Сьогодні: PnL ${day.pnl >= 0 ? '+' : ''}${day.pnl.toFixed(2)}, угод ${day.closed}.${cfg.paused ? `\n⏸ Пауза${cfg.pauseReason ? `: ${cfg.pauseReason}` : ''}` : ''}`
    );
  };

  const maybeDailyReport = async () => {
    const { day, time } = nowParts(cfg.timezone);
    if (time < cfg.reportTime || state.data.lastReportDay === day) return;
    state.data.lastReportDay = day;
    state.save();
    await tg.send(formatDailyReport(cfg, state, day, lastRates));
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
            const due = dueWindows(lastWindows, cfg, nowSynced()).sort((a, b) => b.net - a.net);
            for (const w of due) {
              if (state.positions.length >= cfg.maxPositions) break;
              await trader.tryOpen(w);
            }
          }
        });
        if (cfg.mode === 'live' && Date.now() - reconciledAt > cfg.reconcileMin * MIN) await reconcile();
        await maybeDailyReport();
        await heartbeat();
      }
    } catch (e) {
      log.error('Помилка циклу:', e.message);
    }
    const wait = (scanOnly ? cfg.scanIntervalSec : cfg.tickSec) * 1000 - (Date.now() - started);
    for (let t = 0; t < wait && !stopping; t += 250) await sleep(Math.min(250, wait - t));
  }
  if (!scanOnly) await notify(`🛑 Бот зупинено. Відкритих позицій: ${state.positions.length} (залишаються на біржах, стопи на біржах стоять)`);
}

main().catch((e) => {
  log.error(e.message);
  process.exit(1);
});
