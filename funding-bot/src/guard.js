'use strict';

const log = require('./logger');

/**
 * Аварійні запобіжники: автоматична пауза нових входів, якщо
 *  - реалізований збиток за сьогодні більший за maxDailyLossUsdt;
 *  - maxLossStreak збиткових угод поспіль;
 *  - maxErrors помилок ордерів за 10 хвилин.
 * Відкриті позиції далі супроводжуються і закриваються за правилами. Знімається лише вручну (/resume).
 */
class Guard {
  constructor(cfg, state, settings, notify) {
    this.cfg = cfg;
    this.state = state;
    this.settings = settings;
    this.notify = notify;
    this.errors = [];
    this.now = () => Date.now();
  }

  async trip(reason) {
    if (this.cfg.paused && this.cfg.pauseReason) return;
    this.cfg.pauseReason = reason;
    if (this.settings) this.settings.setPaused(true);
    else this.cfg.paused = true;
    log.warn(`ЗАПОБІЖНИК: ${reason}`);
    await this.notify(
      `🛑 АВТОПАУЗА: ${reason}\nНові позиції не відкриваються. Відкриті супроводжуються і закриваються за правилами.\n` +
        'Перевірте ситуацію і натисніть ▶️ Старт (/resume), щоб продовжити.'
    );
  }

  /** Після кожної закритої угоди. */
  async onTradeClosed(pnl) {
    const s = this.state.data.stats;
    s.lossStreak = pnl < 0 ? (s.lossStreak || 0) + 1 : 0;
    this.state.save();
    const day = this.state.day();
    if (this.cfg.maxDailyLossUsdt > 0 && day.pnl <= -this.cfg.maxDailyLossUsdt) {
      return this.trip(`збиток за сьогодні ${day.pnl.toFixed(2)} ${this.cfg.quote} — більше ліміту ${this.cfg.maxDailyLossUsdt}`);
    }
    if (this.cfg.maxLossStreak > 0 && s.lossStreak >= this.cfg.maxLossStreak) {
      return this.trip(`${s.lossStreak} збиткових угод поспіль`);
    }
    return undefined;
  }

  /** Помилка ордера/біржі (не вдалось відкрити, закрити, вирівняти). */
  async onError(what) {
    const now = this.now();
    this.errors = this.errors.filter((t) => now - t < 10 * 60000);
    this.errors.push(now);
    log.warn(`Помилка (${this.errors.length} за 10 хв): ${what}`);
    if (this.cfg.maxErrors > 0 && this.errors.length >= this.cfg.maxErrors) {
      this.errors = [];
      return this.trip(`${this.cfg.maxErrors} помилок ордерів за 10 хв (остання: ${what})`);
    }
    return undefined;
  }

  resume() {
    this.cfg.pauseReason = undefined;
    this.errors = [];
    this.state.data.stats.lossStreak = 0;
    this.state.save();
  }
}

module.exports = { Guard };
