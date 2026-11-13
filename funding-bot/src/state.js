'use strict';

const fs = require('fs');
const path = require('path');

class State {
  constructor(file) {
    this.file = file;
    this.data = { positions: [], closed: [], stats: { realizedPnl: 0, fundingEarned: 0, feesPaid: 0 } };
    this.load();
  }

  load() {
    if (!this.file || !fs.existsSync(this.file)) return;
    try {
      this.data = { ...this.data, ...JSON.parse(fs.readFileSync(this.file, 'utf8')) };
    } catch (e) {
      throw new Error(`Не вдалося прочитати ${this.file}: ${e.message}`);
    }
  }

  save() {
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file); // атомарний запис
  }

  get positions() {
    return this.data.positions;
  }

  addPosition(p) {
    this.data.positions.push(p);
    this.save();
  }

  closePosition(id, result) {
    const i = this.data.positions.findIndex((p) => p.id === id);
    if (i < 0) return;
    const [p] = this.data.positions.splice(i, 1);
    this.data.closed.push({ ...p, ...result, closedAt: Date.now() });
    this.data.stats.realizedPnl += result.pnl || 0;
    this.data.stats.fundingEarned += p.fundingAccrued || 0;
    this.data.stats.feesPaid += (p.feesPaid || 0) + (result.closeFees || 0);
    this.save();
  }
}

module.exports = { State };
