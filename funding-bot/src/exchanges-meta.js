'use strict';

/**
 * Підтримувані біржі: назва в боті -> налаштування ccxt і особливості.
 *
 * settles      — валюти розрахунку перпетуалів, яким надаємо перевагу (по порядку).
 * password     — чи потрібна passphrase до API-ключа.
 * balanceParams— параметри fetchBalance для ф'ючерсного рахунку.
 * openParams   — додаткові параметри ордера на відкриття (деякі біржі інакше ставлять плече x1).
 * hourAligned  — біржа не віддає час виплати, але платить рівно на початку кожного інтервалу (UTC).
 */
const META = {
  binance: {
    title: 'Binance',
    ccxt: 'binance',
    options: { defaultType: 'swap' },
    settles: ['USDT'],
    keyHint: 'API Management → Enable Futures. Без Withdrawals.',
  },
  bybit: {
    title: 'Bybit',
    ccxt: 'bybit',
    options: { defaultType: 'swap' },
    settles: ['USDT'],
    keyHint: 'API → System-generated, права Contract/Derivatives Trade.',
  },
  htx: {
    title: 'HTX (Huobi)',
    ccxt: 'htx',
    aliases: ['huobi'],
    options: { defaultType: 'swap', defaultSubType: 'linear' },
    settles: ['USDT'],
    openParams: (leverage) => ({ leverRate: leverage }),
    keyHint: 'API Management, права Trade. Для USDT-M ф\'ючерсів.',
  },
  okx: {
    title: 'OKX',
    ccxt: 'okx',
    options: { defaultType: 'swap' },
    settles: ['USDT'],
    password: true,
    keyHint: 'API → права Trade, потрібна Passphrase.',
  },
  bitget: {
    title: 'Bitget',
    ccxt: 'bitget',
    options: { defaultType: 'swap' },
    settles: ['USDT'],
    password: true,
    keyHint: 'API Management → права Futures (read/write), потрібна Passphrase.',
  },
  kucoin: {
    title: 'KuCoin Futures',
    ccxt: 'kucoinfutures',
    settles: ['USDT'],
    password: true,
    balanceParams: {},
    openParams: (leverage, marginMode) => ({ leverage, marginMode }),
    keyHint: 'API Management → права Futures Trading, потрібна Passphrase.',
  },
  bingx: {
    title: 'BingX',
    ccxt: 'bingx',
    options: { defaultType: 'swap' },
    settles: ['USDT'],
    keyHint: 'API Management → права Perpetual Futures Trading.',
  },
  kraken: {
    title: 'Kraken Futures',
    ccxt: 'krakenfutures',
    settles: ['USD'], // мультиколатеральні PF_-перпетуали рахуються в USD
    balanceParams: {}, // flex-рахунок
    balanceCurrencies: ['USD', 'USDT', 'USDC'],
    hourAligned: true,
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
