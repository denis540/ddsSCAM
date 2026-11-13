'use strict';

const fs = require('fs');
const path = require('path');
const log = require('./logger');

/**
 * Перевірка, що монета з однаковою назвою на різних біржах — та сама монета.
 *
 * 1) Адреса контракту: з fetchCurrencies кожної біржі беремо адреси токена в мережах (ERC20, BEP20, SOL, ...).
 *    Якщо в спільній мережі адреси збігаються — монета підтверджена; якщо в усіх спільних мережах
 *    різні — це різні монети, пара блокується.
 * 2) Ціна: якщо ціни на двох біржах відрізняються більше ніж на coinPriceTolPct — різні монети
 *    (працює й там, де адрес немає).
 * 3) Ручні рішення: /coinban, /coinok — мають найвищий пріоритет.
 */

// Уніфікація назв мереж між біржами
const NET_ALIASES = {
  ETH: 'ERC20', ETHEREUM: 'ERC20', ERC20: 'ERC20',
  BSC: 'BEP20', BNB: 'BEP20', BEP20: 'BEP20', 'BEP20(BSC)': 'BEP20', BNBSMARTCHAIN: 'BEP20',
  TRX: 'TRC20', TRON: 'TRC20', TRC20: 'TRC20',
  SOL: 'SOL', SOLANA: 'SOL', SPL: 'SOL',
  ARB: 'ARB', ARBITRUM: 'ARB', ARBONE: 'ARB', ARBITRUMONE: 'ARB',
  OP: 'OP', OPTIMISM: 'OP', OPETH: 'OP',
  MATIC: 'POLYGON', POLYGON: 'POLYGON', POL: 'POLYGON',
  AVAXC: 'AVAXC', AVAX: 'AVAXC', 'AVAX-C': 'AVAXC', AVAXCCHAIN: 'AVAXC', CCHAIN: 'AVAXC',
  BASE: 'BASE', BASEEVM: 'BASE',
  TON: 'TON', SUI: 'SUI', APT: 'APT', APTOS: 'APT',
};
const normNet = (n) => {
  const k = String(n || '').toUpperCase().replace(/[\s_]/g, '');
  return NET_ALIASES[k] || k;
};

const ADDR_KEYS = /^(contractaddress|contract_address|ctaddr|tokenaddress|token_address|contract)$/i;

/** Рекурсивно шукає адресу контракту в сирому info біржі. */
function findAddress(obj, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 3) return undefined;
  for (const [k, v] of Object.entries(obj)) {
    if (ADDR_KEYS.test(k) && typeof v === 'string' && v.length >= 20 && !/^(null|none|0x0+)$/i.test(v)) return v.trim();
  }
  for (const v of Object.values(obj)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const a = findAddress(v, depth + 1);
      if (a) return a;
    }
  }
  return undefined;
}

/** Адреси монети по мережах з уніфікованої структури валюти ccxt. */
function extractAddresses(currency) {
  const out = {};
  for (const [code, net] of Object.entries((currency && currency.networks) || {})) {
    const addr = findAddress(net && net.info);
    if (addr) out[normNet(net.network || code)] = addr.toLowerCase();
  }
  // Деякі біржі (HTX, Bitget, KuCoin, BingX) кладуть список мереж у info.chains / networkList
  const info = (currency && currency.info) || {};
  for (const list of [info.chains, info.networkList, info.networks].filter(Array.isArray)) {
    for (const ch of list) {
      const addr = findAddress(ch);
      const net = ch.chain || ch.network || ch.chainName || ch.baseChain || ch.displayName;
      if (addr && net && !out[normNet(net)]) out[normNet(net)] = addr.toLowerCase();
    }
  }
  return out;
}

class CoinRegistry {
  constructor(cfg, file) {
    this.cfg = cfg;
    this.file = file;
    this.addresses = {}; // exId -> coin -> { net: addr }
    this.loadedAt = {}; // exId -> ts
    this.manual = { banned: {}, trusted: {} }; // coin -> [exIds] | ['*']
    if (file && fs.existsSync(file)) {
      try {
        this.manual = { banned: {}, trusted: {}, ...JSON.parse(fs.readFileSync(file, 'utf8')) };
      } catch {
        /* пошкоджений файл ігноруємо */
      }
    }
  }

  save() {
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.manual, null, 2));
  }

  /** Завантажує адреси монет з біржі (якщо біржа дозволяє — деяким потрібен API-ключ). */
  async load(ex) {
    if (!ex.client.has.fetchCurrencies) return 0;
    try {
      const currencies = await ex.client.fetchCurrencies();
      const map = {};
      for (const [code, cur] of Object.entries(currencies || {})) {
        const a = extractAddresses(cur);
        if (Object.keys(a).length) map[code] = a;
      }
      this.addresses[ex.id] = map;
      this.loadedAt[ex.id] = Date.now();
      log.info(`${ex.title}: адреси контрактів для ${Object.keys(map).length} монет`);
      return Object.keys(map).length;
    } catch (e) {
      log.debug(`${ex.id} fetchCurrencies: ${e.message}`);
      this.loadedAt[ex.id] = Date.now();
      return 0;
    }
  }

  async loadAll(exchanges) {
    await Promise.all(Object.values(exchanges).map((ex) => this.load(ex)));
  }

  isBanned(coin, exId) {
    const b = this.manual.banned[coin];
    return Boolean(b && (b.includes('*') || b.includes(exId)));
  }

  isTrusted(coin) {
    return Boolean(this.manual.trusted[coin]);
  }

  /** Порівняння адрес монети на двох біржах: confirmed | mismatch | unknown */
  compareAddresses(coin, exA, exB) {
    const a = (this.addresses[exA] || {})[coin];
    const b = (this.addresses[exB] || {})[coin];
    if (!a || !b) return { status: 'unknown' };
    const common = Object.keys(a).filter((n) => b[n]);
    if (!common.length) return { status: 'unknown' };
    const same = common.filter((n) => a[n] === b[n]);
    if (same.length) return { status: 'confirmed', networks: same };
    return { status: 'mismatch', networks: common, a, b };
  }

  /**
   * Чи можна торгувати монету між двома біржами.
   * @param {number} [markA] ціна за 1 монету на A
   * @param {number} [markB]
   * @returns {{ok:boolean, reason?:string, status:string}}
   */
  check(coin, exA, exB, markA, markB) {
    if (this.isBanned(coin, exA) || this.isBanned(coin, exB)) return { ok: false, status: 'banned', reason: 'заборонено вручну (/coinban)' };
    const trusted = this.isTrusted(coin);
    const addr = this.compareAddresses(coin, exA, exB);
    if (addr.status === 'mismatch' && !trusted) {
      return { ok: false, status: 'mismatch', reason: `різні адреси контракту (${addr.networks.join(', ')})` };
    }
    if (markA && markB) {
      const diff = Math.abs(markA - markB) / Math.min(markA, markB);
      if (diff > this.cfg.coinPriceTol && !trusted) {
        return { ok: false, status: 'price', reason: `ціни відрізняються на ${(diff * 100).toFixed(1)}% — схоже, різні монети` };
      }
    }
    if (this.cfg.strictCoins && addr.status !== 'confirmed' && !trusted) {
      return { ok: false, status: 'unknown', reason: 'адресу не підтверджено (strictcoins on)' };
    }
    return { ok: true, status: trusted ? 'trusted' : addr.status };
  }

  ban(coin, exId = '*') {
    const list = new Set(this.manual.banned[coin] || []);
    list.add(exId);
    this.manual.banned[coin] = [...list];
    delete this.manual.trusted[coin];
    this.save();
  }

  trust(coin) {
    this.manual.trusted[coin] = true;
    delete this.manual.banned[coin];
    this.save();
  }

  reset(coin) {
    delete this.manual.banned[coin];
    delete this.manual.trusted[coin];
    this.save();
  }
}

module.exports = { CoinRegistry, extractAddresses, normNet, findAddress };
