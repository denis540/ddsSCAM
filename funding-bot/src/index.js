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
const { untrustedRates } = require('./exchanges-meta');
const { planWindows, dueWindows } = require('./scanner');
const { Trader } = require('./trader');
const { State } = require('./state');
const { Settings } = require('./settings');
const { Telegram } = require('./telegram');
const { KeyStore } = require('./keys');
const { CoinRegistry } = require('./coins');
const { Guard } = require('./guard');
const { Reconciler } = require('./reconcile');
const { acquireLock } = require('./lock');
const { runBacktest } = require('./backtest');
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
  // Лише одна копія бота: дві торгували б одним рахунком
  if (!scanOnly) acquireLock(cfg.lockFile);
  const state = new State(cfg.stateFile, cfg.timezone);
  state.pendingNotes = [];
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

  const keys = new KeyStore(cfg.credentials, cfg.keysFile, cfg.keysSecret);
  // all — усі налаштовані біржі (у т.ч. ті, що поки не підключились); exchanges — робочі
  const all = {};
  const exchanges = {};
  const initErrors = {};
  for (const id of cfg.exchanges) {
    try {
      const ex = new Exchange(id, keys.get(id), { quote: cfg.quote, defaultTakerFee: cfg.defaultTakerFee });
      if (cfg.sandbox && !ex.enableSandbox(cfg.testEnv[id])) {
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

  const applySelfTest = (ex, r) => {
    const failed = r.checks.filter((c) => !c.ok && c.critical !== false).map((c) => `${c.name}: ${c.info}`);
    if (failed.length) ex.tradeBlocked = `самоперевірка не пройдена — ${failed.join('; ')}`;
    else if (ex.tradeBlocked && ex.tradeBlocked.startsWith('самоперевірка')) ex.tradeBlocked = undefined;
  };
  /**
   * Live, біржа з ключем: фактичні комісії + самоперевірка. Викликається при старті, коли біржа
   * підключилась пізніше, і після додавання ключа через Telegram — щоб жодна біржа не торгувала без перевірки.
   */
  const prepareKeyedExchange = async (ex, { quiet = false } = {}) => {
    if (!ex.hasKeys || !ex.ready) return;
    // фактичні комісії акаунта — і в paper теж, щоб результат paper-тесту відповідав live
    await ex.loadAccountFees().catch((e) => log.debug(`${ex.id} fees: ${e.message}`));
    if (cfg.mode !== 'live' || !cfg.selfTestOnStart) return;
    const avoid = state.positions.filter((p) => p.shortEx === ex.id || p.longEx === ex.id).map((p) => p.symbol);
    const r = await ex.runSelfTest({ avoid }).catch((e) => ({ ok: false, checks: [{ name: 'самоперевірка', ok: false, critical: true, info: e.message }] }));
    applySelfTest(ex, r);
    if (!r.ok) {
      const msg = `⛔ ${ex.title}: самоперевірка не пройдена — бот не торгує на цій біржі\n${r.checks.filter((c) => !c.ok).map((c) => `   ✗ ${c.name}: ${c.info}`).join('\n')}`;
      if (quiet) state.pendingNotes.push(msg); // надішлемо після старту Telegram
      else await notify(msg);
    }
  };
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
            if (trader) {
              // біржа підключилась уже після старту — теж перевіряємо перед торгівлею
              await prepareKeyedExchange(ex);
              if (trader.coins) trader.coins.load(ex).catch(() => {});
            }
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
      await notify(`⏰ Годинник комп'ютера розходиться з біржами на ${(median / 1000).toFixed(1)} с. Бот це компенсує сам (поправка оновлюється кожні 10 хв), втручання не потрібне.`);
    }
  };
  await syncClock();

  // ---- Live: фактичні комісії акаунта і самоперевірка кожної біржі з ключем (і тих, що підключаться пізніше) ----
  state.pendingNotes = [];
  if (!scanOnly) {
    const keyed = Object.values(exchanges).filter((e) => e.hasKeys);
    await Promise.all(keyed.map((ex) => prepareKeyedExchange(ex, { quiet: true })));
    if (cfg.mode === 'live') log.info(`Самоперевірка: ${keyed.map((ex) => `${ex.id} ${ex.selfTest ? (ex.selfTest.ok ? 'ok' : 'FAIL') : '—'}`).join(', ')}`);
  }

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
      checkPositionMode, applySelfTest, onKeyAdded: (ex) => prepareKeyedExchange(ex),
      runBacktest: (days) => {
        const exs = { ...exchanges };
        for (const id of untrustedRates(Object.keys(exs), cfg.trustRates)) delete exs[id];
        return runBacktest({ exchanges: exs, cfg, days, maxCoins: 40, rates: lastRates });
      },
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
    for (const n of state.pendingNotes || []) await notify(n);
    if (cfg.mode === 'live' && !cfg.telegram.pin) await notify('🔐 Порада: задайте TELEGRAM_PIN у .env — тоді зміна ключів, налаштувань і закриття позицій вимагатимуть PIN.');
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
    // поправку на годинник ПК оновлюємо часто: годинник Windows «пливе», а Bybit відхиляє запити з часом, що випереджає біржу на 1+ с
    if (Date.now() - clockSyncedAt > 10 * MIN) await syncClock();
    if (Date.now() - statusAt > 5 * MIN) await checkStatuses();
    if (Date.now() - imbalanceAt > 30 * MIN) await checkImbalance().catch((e) => log.debug(`imbalance: ${e.message}`));
    const rates = await fetchAllRates();
    // біржі з непідтвердженим масштабом ставок не беруть участі в угодах (лише довідка)
    const tradeRates = { ...rates };
    for (const id of untrustedRates(Object.keys(rates), cfg.trustRates)) delete tradeRates[id];
    let wins = planWindows(tradeRates, cfg, takerFee, nowSynced(), coinCheck);
    // У режимі монет торгуємо лише ті монети, для яких задано кількість
    if (cfg.sizeMode === 'coins') wins = wins.filter((w) => cfg.coinQty[coinOf(w.symbol)] > 0);
    lastRates = rates;
    lastWindows = wins;
    lastScanAt = Date.now();
    printTable(wins, cfg.topN);
    // Підсумок скану в журнал: видно, що бот бачить і коли наступний вхід (навіть якщо угод немає)
    const now = nowSynced();
    const upcoming = wins.filter((w) => w.startTs - now > cfg.entryMinSec * 1000).sort((a, b) => a.startTs - b.startTs || b.net - a.net);
    const next = upcoming[0];
    const ok = Object.entries(rates).map(([id, r]) => `${id}:${Object.keys(r).length}`).join(' ');
    log.info(
      `Скан: ставки ${ok}; вікон за порогами і фільтрами: ${wins.length}` +
        (next
          ? `; найближчий вхід — ${coinOf(next.symbol)} SHORT ${next.shortEx}/LONG ${next.longEx}, виплата ${clock(next.startTs, cfg.timezone)} (через ${duration(next.startTs - now)}, вхід за ${cfg.entryBeforeSec} с), чистий ${pct(next.net)}`
          : '') +
        (cfg.paused ? `; ⏸ ПАУЗА${cfg.pauseReason ? `: ${cfg.pauseReason}` : ''}` : '') +
        (state.positions.length >= cfg.maxPositions ? `; макс. позицій зайнято (${state.positions.length}/${cfg.maxPositions})` : '')
    );
  };

  // ---- Техроботи на біржах: не входимо, поки біржа не в нормі ----
  let statusAt = 0;
  const checkStatuses = async () => {
    statusAt = Date.now();
    await Promise.all(
      Object.values(exchanges).map(async (ex) => {
        const was = ex.maintenance;
        try {
          await ex.checkStatus();
        } catch (e) {
          log.debug(`${ex.id} status: ${e.message}`);
        }
        if (ex.maintenance && !was) notify(`🛠 ${ex.title}: ${ex.maintenance} — нові входи на цій біржі призупинено`).catch(() => {});
        if (!ex.maintenance && was) notify(`✅ ${ex.title}: техроботи завершено`).catch(() => {});
      })
    );
  };

  // ---- Перекіс балансів між біржами (live): попередження, щоб перекинути кошти вручну ----
  let imbalanceAt = 0;
  let imbalanceWarnedAt = 0;
  const checkImbalance = async () => {
    imbalanceAt = Date.now();
    if (cfg.mode !== 'live' || !(cfg.imbalanceRatio > 0)) return;
    const keyed = Object.values(exchanges).filter((e) => e.hasKeys && !e.tradeBlocked);
    if (keyed.length < 2) return;
    const bal = (await Promise.all(keyed.map(async (ex) => [ex, await ex.balanceSummary().catch(() => undefined)]))).filter(([, b]) => b);
    if (bal.length < 2) return;
    bal.sort((a, b) => b[1].total - a[1].total);
    const [hi, lo] = [bal[0], bal[bal.length - 1]];
    if (lo[1].total > 0 && hi[1].total / lo[1].total < cfg.imbalanceRatio) return;
    if (Date.now() - imbalanceWarnedAt < 12 * HOUR) return;
    imbalanceWarnedAt = Date.now();
    await notify(
      `⚖️ Баланси між біржами нерівні: ${bal.map(([ex, b]) => `${ex.id} ${b.total.toFixed(0)}`).join(', ')} ${cfg.quote}.\n` +
        `На ${lo[0].title} угоди будуть меншими (або не відкриються). Варто перекинути частину коштів з ${hi[0].title} вручну.`
    );
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

  // Збій посеред відкриття — звірка якнайшвидше (закриє непарні ноги)
  trader.onCrashDuringOpen = () => {
    reconciledAt = 0;
  };

  // Сканування (ставки всіх бірж, тікери, статуси) — у фоні: повільна біржа чи помилка тут
  // не повинні затримувати нагляд за відкритими позиціями (ризик ліквідації кожні 5 с).
  let scanning = false;
  const runScan = () => {
    if (scanning) return;
    scanning = true;
    scan()
      .catch((e) => log.error('Помилка сканування:', e.message))
      .finally(() => {
        scanning = false;
      });
  };
  try {
    await scan(); // перші дані — до старту торгового циклу
  } catch (e) {
    log.error('Помилка сканування:', e.message);
  }

  let nextScan = Date.now() + cfg.scanIntervalSec * 1000;
  while (!stopping) {
    const started = Date.now();
    if (started >= nextScan) {
      nextScan = started + cfg.scanIntervalSec * 1000;
      if (scanOnly) {
        try {
          await scan();
        } catch (e) {
          log.error('Помилка сканування:', e.message);
        }
      } else {
        runScan();
      }
    }
    if (!scanOnly) {
      try {
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
      } catch (e) {
        log.error('Помилка торгового циклу:', e.message);
      }
      try {
        if (cfg.mode === 'live' && Date.now() - reconciledAt > cfg.reconcileMin * MIN) await reconcile();
        await maybeDailyReport();
        await heartbeat();
      } catch (e) {
        log.error('Помилка службових задач:', e.message);
      }
    }
    const wait = (scanOnly ? cfg.scanIntervalSec : cfg.tickSec) * 1000 - (Date.now() - started);
    for (let t = 0; t < wait && !stopping; t += 250) await sleep(Math.min(250, wait - t));
  }
  if (!scanOnly) {
    const left = state.positions.length;
    await notify(
      `🛑 Бот зупинено. Відкритих позицій: ${left}` +
        (left ? (cfg.mode === 'live' ? ' (залишаються на біржах, стопи на біржах стоять)' : ' (paper: після запуску бот продовжить їх супровід)') : '')
    );
  }
}

main().catch((e) => {
  log.error(e.message);
  process.exit(1);
});
