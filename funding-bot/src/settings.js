'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Налаштування, які можна змінювати на льоту (через Telegram).
 * type pct — користувач вводить у відсотках (0.1 = 0.1%), у cfg зберігається частка (0.001).
 */
const SCHEMA = {
  minspread: { field: 'minSpread8h', type: 'pct', min: 0, desc: 'Мін. різниця фандінгу для входу, % за 8 год' },
  minprofit: { field: 'minExpectedProfitPct', type: 'pct', desc: 'Мін. очікуваний чистий профіт за holdhours, %' },
  exitspread: { field: 'exitSpread8h', type: 'pct', desc: 'Вихід, коли спред впав нижче, % за 8 год' },
  sizemode: { field: 'sizeMode', type: 'enum', values: ['coins', 'usdt'], desc: 'Розмір входу: coins (кількість монет) або usdt' },
  usdt: { field: 'positionUsdt', type: 'num', min: 1, desc: 'Сума входу на кожну ногу, USDT (для sizemode=usdt)' },
  leverage: { field: 'leverage', type: 'int', min: 1, max: 125, desc: 'Плече для нових позицій' },
  marginmode: { field: 'marginMode', type: 'enum', values: ['isolated', 'cross'], desc: 'Режим маржі' },
  maxpos: { field: 'maxPositions', type: 'int', min: 0, max: 100, desc: 'Макс. одночасно відкритих пар' },
  holdhours: { field: 'holdHoursEstimate', type: 'num', min: 1, desc: 'Горизонт окупності входу, год' },
  maxhold: { field: 'maxHoldHours', type: 'num', min: 1, desc: 'Примусовий вихід через N год' },
  basis: { field: 'maxEntryBasisPct', type: 'pct', min: 0, desc: 'Макс. несприятлива різниця цін між біржами, %' },
  slippage: { field: 'maxSlippagePct', type: 'pct', min: 0, desc: 'Макс. слипедж по стакану, %' },
  liqbuffer: { field: 'liqBufferPct', type: 'pct', min: 1, max: 90, desc: 'Закрити, якщо до ліквідації менше, %' },
  maxrate: { field: 'maxAbsFundingRate', type: 'pct', min: 0, desc: 'Ігнорувати ставки фандінгу більші за, %' },
  interval: { field: 'scanIntervalSec', type: 'int', min: 10, desc: 'Інтервал сканування, сек' },
  reporttime: { field: 'reportTime', type: 'time', desc: 'Час щоденного звіту, HH:MM' },
  whitelist: { field: 'whitelist', type: 'list', desc: 'Тільки ці монети (через кому, "-" = усі)' },
  blacklist: { field: 'blacklist', type: 'list', desc: 'Ніколи не торгувати ці монети ("-" = очистити)' },
};

function parse(def, raw) {
  const s = String(raw).trim();
  const n = Number(s.replace(',', '.'));
  switch (def.type) {
    case 'pct':
    case 'num':
    case 'int': {
      if (!Number.isFinite(n)) throw new Error('потрібне число');
      if (def.type === 'int' && !Number.isInteger(n)) throw new Error('потрібне ціле число');
      if (def.min !== undefined && n < def.min) throw new Error(`мінімум ${def.min}`);
      if (def.max !== undefined && n > def.max) throw new Error(`максимум ${def.max}`);
      return def.type === 'pct' ? n / 100 : n;
    }
    case 'enum':
      if (!def.values.includes(s.toLowerCase())) throw new Error(`допустимо: ${def.values.join(', ')}`);
      return s.toLowerCase();
    case 'time':
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(s)) throw new Error('формат HH:MM, напр. 23:55');
      return s;
    case 'list':
      if (s === '-' || s === '') return [];
      return s.split(/[,\s]+/).map((x) => x.trim().toUpperCase()).filter(Boolean);
    default:
      throw new Error('невідомий тип');
  }
}

function display(def, v) {
  if (def.type === 'pct') return `${+(v * 100).toFixed(6)}%`;
  if (def.type === 'list') return v.length ? v.join(',') : '—';
  return String(v);
}

class Settings {
  constructor(cfg, file) {
    this.cfg = cfg;
    this.file = file;
    this.overrides = {};
    this.load();
  }

  load() {
    if (!this.file || !fs.existsSync(this.file)) return;
    const saved = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    for (const [k, raw] of Object.entries(saved.values || {})) {
      if (!SCHEMA[k]) continue;
      try {
        this.cfg[SCHEMA[k].field] = parse(SCHEMA[k], raw);
        this.overrides[k] = raw;
      } catch {
        /* ігноруємо зіпсоване значення */
      }
    }
    if (saved.coinQty) this.cfg.coinQty = { ...this.cfg.coinQty, ...saved.coinQty };
    for (const [c, q] of Object.entries(this.cfg.coinQty)) if (!(q > 0)) delete this.cfg.coinQty[c];
    if (typeof saved.paused === 'boolean') this.cfg.paused = saved.paused;
  }

  save() {
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const data = { values: this.overrides, coinQty: this.cfg.coinQty, paused: this.cfg.paused };
    fs.writeFileSync(this.file, JSON.stringify(data, null, 2));
  }

  /** @returns {string} нове значення для відображення */
  set(key, raw) {
    const def = SCHEMA[String(key).toLowerCase()];
    if (!def) throw new Error(`невідомий параметр "${key}". Список: /settings`);
    const v = parse(def, raw);
    this.cfg[def.field] = v;
    this.overrides[key.toLowerCase()] = raw;
    this.save();
    return display(def, v);
  }

  setQty(coin, raw) {
    const c = String(coin).toUpperCase().split('/')[0];
    const q = Number(String(raw).replace(',', '.'));
    if (!Number.isFinite(q) || q < 0) throw new Error('кількість має бути числом ≥ 0');
    if (q === 0) delete this.cfg.coinQty[c];
    else this.cfg.coinQty[c] = q;
    this.save();
    return c;
  }

  setPaused(p) {
    this.cfg.paused = !!p;
    this.save();
  }

  describe() {
    return Object.entries(SCHEMA)
      .map(([k, def]) => `${k} = ${display(def, this.cfg[def.field])}\n   ${def.desc}`)
      .join('\n');
  }
}

module.exports = { Settings, SCHEMA };
