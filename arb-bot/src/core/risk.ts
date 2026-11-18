import fs from 'node:fs';
import { log } from './logger.js';
import type { Config } from '../config.js';

/** Kill-switch & loss limits. Once halted, only a restart re-enables trading. */
export class RiskManager {
  halted = false;
  haltReason = '';
  private day = utcDay();
  dailyPnl = 0;
  consecutiveFailures = 0;
  trades = 0;

  constructor(private cfg: Config['risk'], private stopFile = 'STOP') {}

  canTrade(): boolean {
    this.rollDay();
    if (fs.existsSync(this.stopFile)) this.halt('STOP file present');
    return !this.halted;
  }

  recordTrade(pnlUsd: number) {
    this.rollDay();
    this.trades++;
    this.dailyPnl += pnlUsd;
    this.consecutiveFailures = 0;
    if (this.dailyPnl <= -this.cfg.maxDailyLossUsd) this.halt(`daily loss limit hit: ${this.dailyPnl.toFixed(2)} USD`);
  }

  recordFailure(lossUsd: number) {
    this.rollDay();
    this.dailyPnl -= Math.abs(lossUsd);
    this.consecutiveFailures++;
    if (this.consecutiveFailures >= this.cfg.maxConsecutiveFailures) this.halt(`${this.consecutiveFailures} consecutive failures`);
    if (this.dailyPnl <= -this.cfg.maxDailyLossUsd) this.halt(`daily loss limit hit: ${this.dailyPnl.toFixed(2)} USD`);
  }

  halt(reason: string) {
    if (this.halted) return;
    this.halted = true;
    this.haltReason = reason;
    log.error('TRADING HALTED', { reason });
  }

  /** Human override via Telegram /resume (STOP file still wins). */
  resume() {
    this.halted = false;
    this.haltReason = '';
    this.consecutiveFailures = 0;
    log.warn('trading resumed manually');
  }

  private rollDay() {
    const d = utcDay();
    if (d !== this.day) {
      log.info('new UTC day, resetting daily pnl', { prevPnl: this.dailyPnl });
      this.day = d;
      this.dailyPnl = 0;
    }
  }
}

function utcDay() {
  return new Date().toISOString().slice(0, 10);
}
