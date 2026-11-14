'use strict';

const fs = require('fs');
const path = require('path');
const log = require('./logger');
const { nowParts } = require('./time');

const emptyDay = () => ({ opened: 0, closed: 0, pnl: 0, funding: 0, fees: 0 });

class State {
  constructor(file, timezone = 'UTC') {
    this.file = file;
    this.timezone = timezone;
    this.data = {
      positions: [],
      closed: [],
      stats: { realizedPnl: 0, fundingEarned: 0, feesPaid: 0, trades: 0, wins: 0 },
      daily: {},
      lastReportDay: undefined,
      pending: [], // наміри угод: записуються ДО відправки ордерів (для звірки після падіння)
    };
    this.load();
  }

  load() {
    if (!this.file || !fs.existsSync(this.file)) return;
    try {
      const saved = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.data = { ...this.data, ...saved, stats: { ...this.data.stats, ...saved.stats } };
    } catch (e) {
      throw new Error(`Не вдалося прочитати ${this.file}: ${e.message}`);
    }
  }

  /**
   * Атомарний запис (тимчасовий файл → заміна). На Windows антивірус/індексатор/OneDrive інколи на мить
   * блокують файл (EPERM/EBUSY) — повторюємо, а в крайньому разі пишемо напряму.
   * Ніколи не кидає помилку: збій запису не має зірвати торгову дію (напр. постановку стопів після входу).
   */
  save() {
    if (!this.file) return;
    const body = JSON.stringify(this.data, null, 2);
    const tmp = `${this.file}.tmp`;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(tmp, body);
      for (let i = 0; ; i++) {
        try {
          fs.renameSync(tmp, this.file);
          return;
        } catch (e) {
          if (!['EPERM', 'EBUSY', 'EACCES'].includes(e.code) || i >= 5) throw e;
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50 * (i + 1)); // коротка пауза
        }
      }
    } catch (e) {
      try {
        fs.writeFileSync(this.file, body);
        log.warn(`Стан збережено напряму (заміна файлу не вдалась: ${e.code || e.message})`);
      } catch (e2) {
        log.error(`НЕ вдалося зберегти стан у ${this.file}: ${e2.message}`);
      }
    }
  }

  get positions() {
    return this.data.positions;
  }

  setPending(p) {
    this.data.pending = (this.data.pending || []).filter((x) => x.symbol !== p.symbol);
    this.data.pending.push(p);
    this.save();
  }

  clearPending(symbol) {
    this.data.pending = (this.data.pending || []).filter((x) => x.symbol !== symbol);
    this.save();
  }

  dayKey(ts = Date.now()) {
    return nowParts(this.timezone, ts).day;
  }

  day(key = this.dayKey()) {
    if (!this.data.daily[key]) this.data.daily[key] = emptyDay();
    return this.data.daily[key];
  }

  addDaily(field, amount, ts) {
    this.day(this.dayKey(ts))[field] += amount;
  }

  addPosition(p) {
    this.data.positions.push(p);
    this.addDaily('opened', 1, p.openedAt);
    this.addDaily('fees', p.feesPaid || 0, p.openedAt);
    this.save();
  }

  closePosition(id, result) {
    const i = this.data.positions.findIndex((p) => p.id === id);
    if (i < 0) return undefined;
    const [p] = this.data.positions.splice(i, 1);
    const closed = { ...p, ...result, closedAt: Date.now() };
    this.data.closed.push(closed);
    if (this.data.closed.length > 1000) this.data.closed.splice(0, this.data.closed.length - 1000);
    const s = this.data.stats;
    s.realizedPnl += result.pnl || 0;
    s.fundingEarned += p.fundingAccrued || 0;
    s.feesPaid += (p.feesPaid || 0) + (result.closeFees || 0);
    s.trades += 1;
    if ((result.pnl || 0) > 0) s.wins += 1;
    this.addDaily('closed', 1);
    this.addDaily('pnl', result.pnl || 0);
    this.addDaily('fees', result.closeFees || 0);
    this.save();
    return closed;
  }

  closedOn(dayKey) {
    return this.data.closed.filter((c) => this.dayKey(c.closedAt) === dayKey);
  }
}

module.exports = { State };
