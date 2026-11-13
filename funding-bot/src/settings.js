'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Налаштування, які можна змінювати на льоту (через Telegram).
 * type pct — користувач вводить у відсотках (0.1 = 0.1%), у cfg зберігається частка (0.001).
 */
const SCHEMA = {
  minfunding: { label: 'Мін. фандінг', field: 'minFunding', type: 'pct', min: 0, desc: 'Вхід, лише якщо фандінг за виплату(и) більший за, % (напр. OKX 3% − Binance 1% = 2%)' },
  minprofit: { label: 'Мін. чистий профіт', field: 'minProfit', type: 'pct', desc: 'Мін. чистий профіт після 4 комісій, %' },
  entrybefore: { label: 'Вхід до виплати, с', field: 'entryBeforeSec', type: 'int', min: 10, max: 3600, desc: 'Заходити за N секунд до виплати' },
  entrymin: { label: 'Найпізніший вхід, с', field: 'entryMinSec', type: 'int', min: 3, max: 600, desc: 'Не заходити, якщо до виплати менше N секунд' },
  exitafter: { label: 'Вихід після виплати, с', field: 'exitAfterSec', type: 'int', min: 0, max: 3600, desc: 'Виходити через N секунд після виплати' },
  converge: { label: 'Ціни зійшлися при', field: 'convergePct', type: 'pct', min: 0, desc: 'Ціни зійшлися, якщо різниця між біржами ≤ %' },
  earlyexit: { label: 'Ранній вихід', field: 'earlyExit', type: 'bool', desc: 'Вийти ДО виплати, якщо прибуток від цін уже більший за фандінг (on/off)' },
  maxwindow: { label: 'Макс. вікно, год', field: 'maxWindowHours', type: 'num', min: 0, max: 24, desc: 'Макс. годин між першою і останньою виплатою у вікні (0 = лише одночасні/одна виплата)' },
  estimated: { label: 'Оціночні виплати', field: 'allowEstimated', type: 'bool', desc: 'Враховувати наступні виплати за поточною ставкою (on/off)' },
  sizemode: { label: 'Режим розміру', field: 'sizeMode', type: 'enum', values: ['auto', 'coins', 'usdt'], desc: 'auto — бот сам рахує максимум за стаканами обох бірж і плечем, не більше maxtrade × плече; coins — фіксована кількість монет; usdt — фіксована сума' },
  maxtrade: { label: 'Сума на угоду (маржа)', field: 'maxTradeUsdt', type: 'num', min: 1, desc: 'Ваші гроші на 1 угоду на КОЖНІЙ біржі, USDT. Позиція = сума × плече, але не більше, ніж витримують стакани обох бірж' },
  mintrade: { label: 'Мін. сума угоди', field: 'minTradeUsdt', type: 'num', min: 0, desc: 'Якщо стакан дозволяє менше — не заходити, USDT' },
  exitdepth: { label: 'Стакан на вихід', field: 'checkExitDepth', type: 'bool', desc: 'Враховувати глибину стакану і для виходу (on/off)' },
  usdt: { label: 'Сума входу USDT', field: 'positionUsdt', type: 'num', min: 1, desc: 'Сума входу на кожну ногу, USDT (для sizemode=usdt)' },
  leverage: { label: 'Плече', field: 'leverage', type: 'int', min: 1, max: 125, desc: 'Бажане плече. Фактичне — однакове на обох біржах і не більше максимуму кожної біржі для цієї монети' },
  marginmode: { label: 'Режим маржі', field: 'marginMode', type: 'enum', values: ['isolated', 'cross'], desc: 'Режим маржі' },
  maxpos: { label: 'Макс. позицій', field: 'maxPositions', type: 'int', min: 0, max: 100, desc: 'Макс. одночасно відкритих пар' },
  basis: { label: 'Макс. різниця цін на вході', field: 'maxEntryBasisPct', type: 'pct', min: 0, desc: 'Макс. несприятлива різниця цін між біржами на вході, %' },
  slippage: { label: 'Макс. слипедж', field: 'maxSlippagePct', type: 'pct', min: 0, desc: 'Макс. слипедж по стакану, %' },
  liqclose: { label: 'Закрити при % шляху до ліквідації', field: 'liqClosePct', type: 'pct', min: 10, max: 95, desc: 'Бот закриває пару, коли ціна пройшла стільки % шляху від входу до ліквідації будь-якої ноги' },
  protect: { label: 'Стопи на біржах', field: 'protectStops', type: 'bool', desc: 'Захисні стоп-ордери на самих біржах — спрацюють, навіть якщо бот впав (on/off)' },
  stopat: { label: 'Стоп на біржі при % шляху', field: 'stopAtPct', type: 'pct', min: 20, max: 98, desc: 'Де стоїть стоп на біржі: % шляху від входу до ліквідації (має бути більше за liqclose)' },
  ordertype: { label: 'Тип ордерів', field: 'orderType', type: 'enum', values: ['auto', 'market'], desc: 'auto — бот сам обирає: лімітний IOC з межею ціни або ринковий (термінові закриття); market — завжди ринкові' },
  maxwait: { label: 'Чекати сходження, хв', field: 'maxConvergeWaitMin', type: 'num', min: 0, max: 240, desc: 'Після виплати, якщо вихід зараз у мінус, чекати сходження цін до N хв (0 — виходити через exitafter)' },
  maxdayloss: { label: 'Макс. збиток за день', field: 'maxDailyLossUsdt', type: 'num', min: 0, desc: 'Якщо збиток за день більший — пауза входів, USDT (0 = вимк.)' },
  lossstreak: { label: 'Збиткових поспіль', field: 'maxLossStreak', type: 'int', min: 0, max: 100, desc: 'Стільки збиткових угод поспіль — пауза входів (0 = вимк.)' },
  maxerrors: { label: 'Помилок за 10 хв', field: 'maxErrors', type: 'int', min: 0, max: 100, desc: 'Стільки помилок ордерів за 10 хв — пауза входів (0 = вимк.)' },
  maxtotal: { label: 'Макс. загальна позиція', field: 'maxTotalUsdt', type: 'num', min: 0, desc: 'Сума позицій усіх угод (одна нога), USDT (0 = без ліміту)' },
  maxexchange: { label: 'Макс. на одній біржі', field: 'maxExchangeUsdt', type: 'num', min: 0, desc: 'Сума позицій на одній біржі, USDT (0 = без ліміту)' },
  reserve: { label: 'Резерв балансу', field: 'reservePct', type: 'pct', min: 0, max: 90, desc: 'Частка вільного балансу, яку бот не використовує, %' },
  minvolume: { label: 'Мін. обсяг за 24 год', field: 'minVolumeUsdt', type: 'num', min: 0, desc: 'Мін. обсяг торгів монети на кожній біржі пари, USDT (0 = вимк.)' },
  newlisting: { label: 'Нові монети, днів', field: 'newListingDays', type: 'num', min: 0, desc: 'Не торгувати монети, лістинговані менше N днів тому' },
  delist: { label: 'Делістинг, днів', field: 'delistDays', type: 'num', min: 0, desc: 'Не торгувати монети з делістингом/експірацією в найближчі N днів' },
  heartbeat: { label: 'Пульс, год', field: 'heartbeatHours', type: 'num', min: 0, max: 48, desc: 'Повідомлення «я працюю» кожні N год (0 = вимк.)' },
  reconcile: { label: 'Звірка з біржами, хв', field: 'reconcileMin', type: 'num', min: 0.5, max: 60, desc: 'Як часто порівнювати позиції бота з фактичними позиціями на біржах' },
  liqcheck: { label: 'Перевірка ліквідації, с', field: 'liqCheckSec', type: 'int', min: 5, max: 300, desc: 'Як часто перевіряти, чи не наближається якась нога до ліквідації (обидві біржі одночасно)' },
  maxrate: { label: 'Макс. ставка (аномалії)', field: 'maxAbsFundingRate', type: 'pct', min: 0, desc: 'Ігнорувати ставки фандінгу більші за, % (аномалії)' },
  interval: { label: 'Оновлення ставок, с', field: 'scanIntervalSec', type: 'int', min: 10, desc: 'Інтервал оновлення ставок, сек' },
  pricetol: { label: 'Допуск ціни монет', field: 'coinPriceTol', type: 'pct', min: 0.1, max: 50, desc: 'Якщо ціни монети на біржах відрізняються більше — це різні монети, %' },
  strictcoins: { label: 'Лише підтверджені монети', field: 'strictCoins', type: 'bool', desc: 'Торгувати лише монети з однаковою адресою контракту на обох біржах (on/off)' },
  reporttime: { label: 'Час звіту', field: 'reportTime', type: 'time', desc: 'Час щоденного звіту, HH:MM' },
  whitelist: { label: 'Тільки монети', field: 'whitelist', type: 'list', desc: 'Тільки ці монети (через кому, "-" = усі)' },
  blacklist: { label: 'Чорний список', field: 'blacklist', type: 'list', desc: 'Ніколи не торгувати ці монети ("-" = очистити)' },
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
      return def.type === 'pct' ? Number((n / 100).toPrecision(12)) : n;
    }
    case 'enum':
      if (!def.values.includes(s.toLowerCase())) throw new Error(`допустимо: ${def.values.join(', ')}`);
      return s.toLowerCase();
    case 'bool':
      if (['on', '1', 'true', 'yes', 'так'].includes(s.toLowerCase())) return true;
      if (['off', '0', 'false', 'no', 'ні'].includes(s.toLowerCase())) return false;
      throw new Error('on або off');
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
  if (def.type === 'bool') return v ? 'on' : 'off';
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

module.exports = { Settings, SCHEMA, display };
