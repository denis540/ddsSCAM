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

const mode = (process.env.MODE || 'paper').toLowerCase();
if (!['paper', 'live'].includes(mode)) throw new Error('MODE має бути paper або live');

const exchanges = list('EXCHANGES', ['binance', 'bybit', 'okx', 'bitget', 'gate']).map((s) => s.toLowerCase());

// Ключі шукаються як BINANCE_API_KEY / BINANCE_SECRET / BINANCE_PASSWORD (passphrase для OKX/Bitget/KuCoin)
const credentials = {};
for (const id of exchanges) {
  const p = id.toUpperCase();
  credentials[id] = {
    apiKey: process.env[`${p}_API_KEY`],
    secret: process.env[`${p}_SECRET`],
    password: process.env[`${p}_PASSWORD`],
  };
}

const config = {
  mode,
  exchanges,
  credentials,
  quote: process.env.QUOTE || 'USDT',

  // Розмір і ризик
  positionUsdt: num('POSITION_USDT', 100), // номінал КОЖНОЇ ноги
  leverage: num('LEVERAGE', 3),
  maxPositions: num('MAX_POSITIONS', 3),
  marginMode: process.env.MARGIN_MODE || 'isolated',

  // Вхід
  minSpread8h: num('MIN_SPREAD_8H_PCT', 0.05) / 100, // різниця фандінгу, нормалізована до 8 год
  minExpectedProfitPct: num('MIN_EXPECTED_PROFIT_PCT', 0.1) / 100, // чистий профіт за HOLD_HOURS_ESTIMATE після комісій
  holdHoursEstimate: num('HOLD_HOURS_ESTIMATE', 24),
  maxEntryBasisPct: num('MAX_ENTRY_BASIS_PCT', 0.15) / 100, // макс. несприятлива різниця цін між біржами
  maxSlippagePct: num('MAX_SLIPPAGE_PCT', 0.1) / 100,
  minMinutesToFunding: num('MIN_MINUTES_TO_FUNDING', 0), // 0 = входимо будь-коли
  maxAbsFundingRate: num('MAX_ABS_FUNDING_RATE_PCT', 2) / 100, // відсікаємо аномалії

  // Вихід
  exitSpread8h: num('EXIT_SPREAD_8H_PCT', 0.01) / 100,
  maxHoldHours: num('MAX_HOLD_HOURS', 72),
  liqBufferPct: num('LIQ_BUFFER_PCT', 15) / 100, // закриваємо пару, якщо до ліквідації менше X%

  // Фільтри
  whitelist: list('WHITELIST'), // напр. BTC,ETH,SOL
  blacklist: list('BLACKLIST'),
  defaultTakerFee: num('DEFAULT_TAKER_FEE_PCT', 0.05) / 100,

  scanIntervalSec: num('SCAN_INTERVAL_SEC', 60),
  topN: num('TOP_N_LOG', 10),
  stateFile: process.env.STATE_FILE || 'data/state.json',

  telegram: {
    token: process.env.TELEGRAM_BOT_TOKEN,
    chatId: process.env.TELEGRAM_CHAT_ID,
  },
};

if (config.mode === 'live') {
  for (const id of exchanges) {
    const c = credentials[id];
    if (!c.apiKey || !c.secret) throw new Error(`MODE=live: немає ключів для ${id} (${id.toUpperCase()}_API_KEY / _SECRET)`);
  }
}

module.exports = config;
