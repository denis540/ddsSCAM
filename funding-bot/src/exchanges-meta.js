'use strict';

/**
 * Підтримувані біржі: назва в боті -> налаштування ccxt і особливості.
 *
 * settles      — валюти розрахунку перпетуалів, яким надаємо перевагу (по порядку).
 * password     — чи потрібна passphrase до API-ключа.
 * balanceParams— параметри fetchBalance для ф'ючерсного рахунку.
 * openParams   — додаткові параметри ордера на відкриття (деякі біржі інакше ставлять плече x1).
 * obLimit      — глибина стакану, яку просимо (null — як віддає біржа). За замовчуванням 50.
 * testEnv      — тестове середовище для SANDBOX=true: 'sandbox' (testnet ccxt), 'demo' (Demo Trading), false (немає).
 *                Можна перевизначити в .env: TESTENV_BINANCE=demo|sandbox тощо.
 * hourAligned  — біржа не віддає час виплати, але платить рівно на початку кожного інтервалу (UTC).
 */
const META = {
  binance: {
    testEnv: 'sandbox', // Futures Testnet (testnet.binancefuture.com); TESTENV_BINANCE=demo — Demo Trading (demo-fapi.binance.com)
    title: 'Binance',
    ccxt: 'binance',
    options: { defaultType: 'swap' },
    settles: ['USDT'],
    keyHint: 'API Management → Enable Futures. Без Withdrawals.',
  },
  bybit: {
    testEnv: 'demo', // Demo Trading (api-demo.bybit.com) — НЕ Testnet; ключі створюються в режимі Demo Trading
    title: 'Bybit',
    ccxt: 'bybit',
    options: { defaultType: 'swap' },
    settles: ['USDT'],
    keyHint: 'API → System-generated, права Contract/Derivatives Trade.',
  },
  htx: {
    testEnv: false, // тестового середовища для ф'ючерсів немає
    title: 'HTX (Huobi)',
    ccxt: 'htx',
    aliases: ['huobi'],
    options: { defaultType: 'swap', defaultSubType: 'linear' },
    settles: ['USDT'],
    openParams: (leverage) => ({ leverRate: leverage }),
    obLimit: null, // HTX віддає фіксовану глибину
    keyHint: 'API Management, права Trade. Для USDT-M ф\'ючерсів.',
  },
  okx: {
    testEnv: 'sandbox', // Demo Trading: заголовок x-simulated-trading: 1
    title: 'OKX',
    ccxt: 'okx',
    options: { defaultType: 'swap' },
    settles: ['USDT'],
    password: true,
    keyHint: 'API → права Trade, потрібна Passphrase.',
  },
  bitget: {
    testEnv: 'sandbox', // Demo: заголовок PAPTRADING: 1, ключ «Demo API Key»
    title: 'Bitget',
    ccxt: 'bitget',
    options: { defaultType: 'swap' },
    settles: ['USDT'],
    password: true,
    keyHint: 'API Management → права Futures (read/write), потрібна Passphrase.',
  },
  kucoin: {
    testEnv: false, // ccxt не підтримує sandbox для KuCoin Futures
    title: 'KuCoin Futures',
    ccxt: 'kucoinfutures',
    settles: ['USDT'],
    password: true,
    balanceParams: {},
    openParams: (leverage, marginMode) => ({ leverage, marginMode }),
    obLimit: 100, // KuCoin приймає лише 20 або 100
    keyHint: 'API Management → права Futures Trading, потрібна Passphrase.',
  },
  bingx: {
    testEnv: 'sandbox', // VST (open-api-vst.bingx.com)
    title: 'BingX',
    ccxt: 'bingx',
    options: { defaultType: 'swap' },
    settles: ['USDT'],
    keyHint: 'API Management → права Perpetual Futures Trading.',
  },
  kraken: {
    testEnv: 'sandbox', // demo-futures.kraken.com (можливо, закрито — перевірить npm run check)
    title: 'Kraken Futures',
    ccxt: 'krakenfutures',
    settles: ['USD'], // мультиколатеральні PF_-перпетуали рахуються в USD
    balanceParams: {}, // flex-рахунок
    balanceCurrencies: ['USD', 'USDT', 'USDC'],
    hourAligned: true,
    obLimit: null,
    keyHint: 'Окремі ключі саме від Kraken FUTURES (futures.kraken.com → Settings → API Keys), не від спотового Kraken.',
  },
};

const ALIASES = {};
for (const [name, m] of Object.entries(META)) {
  ALIASES[name] = name;
  ALIASES[m.ccxt] = name;
  for (const a of m.aliases || []) ALIASES[a] = name;
}

/** binance | huobi | kucoinfutures | krakenfutures ... -> назва в боті */
function normalizeName(name) {
  const n = String(name || '').trim().toLowerCase();
  return ALIASES[n] || n;
}

function metaOf(name) {
  return META[normalizeName(name)] || { title: name, ccxt: normalizeName(name), options: { defaultType: 'swap' }, settles: ['USDT'] };
}

module.exports = { META, normalizeName, metaOf, SUPPORTED: Object.keys(META) };
