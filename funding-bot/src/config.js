'use strict';

require('dotenv').config();

const num = (name, def) => {
  const v = process.env[name];
  if (v === undefined || v === '') return def;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`Env ${name} має бути числом, отримано "${v}"`);
  return n;
};
const list = (name, def = []) => {
  const v = process.env[name];
  if (!v) return def;
  return v.split(',').map((s) => s.trim()).filter(Boolean);
};

const bool = (name, def) => {
  const v = process.env[name];
  if (v === undefined || v === '') return def;
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
};

const mode = (process.env.MODE || 'paper').toLowerCase();
if (!['paper', 'live'].includes(mode)) throw new Error('MODE має бути paper або live');

const { SUPPORTED, normalizeName, META } = require('./exchanges-meta');

const exchanges = [...new Set(list('EXCHANGES', SUPPORTED).map(normalizeName))];

// Ключі: BINANCE_API_KEY / BINANCE_SECRET / BINANCE_PASSWORD (passphrase для OKX/Bitget/KuCoin).
// Для HTX підходить і префікс HUOBI_, для KuCoin — KUCOINFUTURES_, для Kraken — KRAKENFUTURES_.
const credentials = {};
for (const id of exchanges) {
  const prefixes = [id, ...((META[id] && META[id].aliases) || []), META[id] ? META[id].ccxt : id].map((x) => x.toUpperCase());
  const pick = (suffix) => prefixes.map((p) => process.env[`${p}_${suffix}`]).find(Boolean);
  credentials[id] = { apiKey: pick('API_KEY'), secret: pick('SECRET'), password: pick('PASSWORD') || pick('PASSPHRASE') };
}

// COIN_QTY=BTC:0.01,ETH:0.2,SOL:5 — кількість монет на вхід для кожної монети
const coinQty = {};
for (const pair of list('COIN_QTY')) {
  const [coin, qty] = pair.split(':').map((x) => x.trim());
  const q = Number(String(qty).replace(',', '.'));
  if (coin && q > 0) coinQty[coin.toUpperCase()] = q;
}

const config = {
  mode,
  exchanges,
  credentials,
  quote: process.env.QUOTE || 'USDT',

  // Розмір і ризик
  // auto  — бот сам рахує по стаканах обох бірж, на яку суму можна зайти, але не більше MAX_TRADE_USDT
  // coins — вхід/вихід фіксованою кількістю монет (COIN_QTY / команда /qty), usdt — фіксованою сумою POSITION_USDT
  sizeMode: (process.env.SIZE_MODE || 'auto').toLowerCase(),
  maxTradeUsdt: num('MAX_TRADE_USDT', 100), // ваша сума (маржа) на 1 угоду на КОЖНІЙ біржі, USDT; позиція = сума × плече
  minTradeUsdt: num('MIN_TRADE_USDT', 20), // якщо стакан дозволяє менше — угоду пропускаємо
  checkExitDepth: bool('CHECK_EXIT_DEPTH', true), // враховувати і стакан на вихід
  coinQty,
  positionUsdt: num('POSITION_USDT', 100), // номінал КОЖНОЇ ноги (для SIZE_MODE=usdt)
  leverage: num('LEVERAGE', 3), // бажане плече; фактичне — не більше максимуму обох бірж для монети, однакове на обох
  maxPositions: num('MAX_POSITIONS', 3),
  marginMode: process.env.MARGIN_MODE || 'isolated',

  // Вхід — під конкретну виплату фандінгу
  minFunding: num('MIN_FUNDING_PCT', 0.1) / 100, // мін. сумарний фандінг за вікно (різниця ставок), %
  minProfit: num('MIN_PROFIT_PCT', 0.05) / 100, // мін. чистий профіт за вікно після 4 комісій, %
  entryBeforeSec: num('ENTRY_BEFORE_SEC', 120), // заходимо приблизно за стільки секунд до виплати
  entryMinSec: num('ENTRY_MIN_SEC', 20), // пізніше цього вже не заходимо (ризик не встигнути)
  maxWindowHours: num('MAX_WINDOW_HOURS', 8), // макс. тривалість вікна між першою і останньою виплатою
  lookaheadHours: num('LOOKAHEAD_HOURS', 8), // на скільки годин уперед показувати можливості (/top)
  allowEstimated: bool('ALLOW_ESTIMATED', true), // враховувати наступні виплати за поточною ставкою
  maxEntryBasisPct: num('MAX_ENTRY_BASIS_PCT', 0.15) / 100, // макс. несприятлива різниця цін між біржами
  maxSlippagePct: num('MAX_SLIPPAGE_PCT', 0.1) / 100,
  maxAbsFundingRate: num('MAX_ABS_FUNDING_RATE_PCT', 10) / 100, // відсікаємо явні аномалії

  // Вихід
  exitAfterSec: num('EXIT_AFTER_SEC', 120), // вихід приблизно через стільки секунд після останньої виплати
  settleDelaySec: num('SETTLE_DELAY_SEC', 10), // раніше цього після виплати не закриваємось (щоб біржа точно нарахувала)
  convergePct: num('CONVERGE_PCT', 0.05) / 100, // ціни «зійшлися», якщо різниця між біржами ≤ X%
  earlyExit: bool('EARLY_EXIT', true), // вийти ще ДО виплати, якщо прибуток від цін уже більший за очікуваний фандінг
  liqBufferPct: num('LIQ_BUFFER_PCT', 15) / 100, // закриваємо пару, якщо до ліквідації менше X%

  // Перевірка, що монети з однаковою назвою — одна й та сама монета
  coinPriceTol: num('COIN_PRICE_TOL_PCT', 3) / 100, // різниця цін більша — вважаємо різними монетами
  strictCoins: bool('STRICT_COINS', false), // торгувати лише монети з підтвердженою адресою контракту
  coinsFile: process.env.COINS_FILE || 'data/coins.json',

  // Фільтри
  whitelist: list('WHITELIST'), // напр. BTC,ETH,SOL
  blacklist: list('BLACKLIST'),
  defaultTakerFee: num('DEFAULT_TAKER_FEE_PCT', 0.05) / 100,

  scanIntervalSec: num('SCAN_INTERVAL_SEC', 30), // як часто оновлювати ставки всіх бірж
  tickSec: num('TICK_SEC', 5), // як часто перевіряти таймінги входу/виходу
  topN: num('TOP_N_LOG', 10),
  stateFile: process.env.STATE_FILE || 'data/state.json',
  settingsFile: process.env.SETTINGS_FILE || 'data/settings.json',
  keysFile: process.env.KEYS_FILE || 'data/keys.json',
  paused: false,

  // Щоденний звіт
  reportTime: process.env.REPORT_TIME || '23:55',
  timezone: process.env.TIMEZONE || 'Europe/Kyiv',

  telegram: {
    token: process.env.TELEGRAM_BOT_TOKEN,
    // Хто може керувати ботом і куди йдуть повідомлення (через кому, можна кілька)
    chatIds: list('TELEGRAM_CHAT_ID'),
  },
};

if (!['auto', 'coins', 'usdt'].includes(config.sizeMode)) throw new Error('SIZE_MODE має бути auto, coins або usdt');

module.exports = config;
