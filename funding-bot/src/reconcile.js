'use strict';

const log = require('./logger');

/**
 * Звірка позицій бота з фактичними позиціями на біржах (live).
 *  - Непарна нога, що лишилась після збою посеред відкриття (є «намір» у state.pending) — закривається одразу.
 *  - Невідома позиція (відкрита не ботом або загублена) — повідомлення з кнопкою «Закрити».
 *  - Розбіжність кількості чи сторони — повідомлення.
 *  - Нога бота, якої немає на біржі, обробляється в Trader.liquidationRisk (закриття другої ноги).
 */
class Reconciler {
  constructor(cfg, state, exchanges, trader, send) {
    this.cfg = cfg;
    this.state = state;
    this.ex = exchanges;
    this.trader = trader;
    this.send = send; // (text, markup?) => Promise
    this.orphans = {}; // id -> { exId, symbol, side, contracts }
    this.alerted = new Set();
    this.seq = 0;
  }

  expected() {
    const out = {};
    for (const p of this.state.positions) {
      for (const [legKey, exId] of [['short', p.shortEx], ['long', p.longEx]]) {
        const leg = p[legKey];
        if (leg.contracts > 0) out[`${exId}|${p.symbol}`] = { side: legKey, contracts: leg.contracts };
      }
    }
    return out;
  }

  async fetchAll() {
    const found = [];
    const failed = [];
    await Promise.all(
      Object.values(this.ex)
        .filter((e) => e.ready && e.hasKeys)
        .map(async (e) => {
          try {
            for (const p of await e.openPositions()) {
              found.push({ exId: e.id, symbol: p.canonical, side: p.side, contracts: Math.abs(p.contracts) });
            }
          } catch (err) {
            failed.push(e.id);
            log.warn(`Звірка: ${e.id} не віддав позиції: ${err.message}`);
          }
        })
    );
    return { found, failed };
  }

  /** @returns {Promise<{orphans:object[], mismatches:string[], autoClosed:string[]}>} */
  async run() {
    if (this.cfg.mode !== 'live') return { orphans: [], mismatches: [], autoClosed: [] };
    const exp = this.expected();
    const { found, failed } = await this.fetchAll();
    const pending = this.state.data.pending || [];
    const orphans = [];
    const mismatches = [];
    const autoClosed = [];
    const seen = new Set();
    for (const f of found) {
      if (this.trader.busy.has(f.symbol)) continue; // зараз відкривається — не чіпаємо
      const key = `${f.exId}|${f.symbol}`;
      const e = exp[key];
      if (!e) {
        orphans.push(f);
        continue;
      }
      seen.add(key);
      const diff = Math.abs(e.contracts - f.contracts) > 1e-9 * Math.max(e.contracts, f.contracts);
      if (e.side !== f.side || diff) {
        mismatches.push(`${f.exId} ${f.symbol.split('/')[0]}: у бота ${e.side} ${e.contracts}, на біржі ${f.side} ${f.contracts}`);
      }
    }

    for (const o of orphans) {
      const fromCrash = pending.some((p) => p.symbol === o.symbol && (p.shortEx === o.exId || p.longEx === o.exId));
      if (fromCrash) {
        // Нога лишилась після збою посеред відкриття — закриваємо одразу (терміново, ринком)
        const ex = this.ex[o.exId];
        const r = await this.trader.closeLegWithRetry(ex, o.symbol, o.side === 'short' ? 'buy' : 'sell', o.contracts, { urgent: true });
        const msg = `${o.exId} ${o.symbol.split('/')[0]} ${o.side} ${o.contracts} контр.`;
        autoClosed.push(msg);
        await this.send(r ? `🧹 Після збою знайдено непарну ногу ${msg} — закрито.` : `🚨 Після збою знайдено непарну ногу ${msg} — НЕ вдалося закрити, закрийте вручну!`);
        continue;
      }
      const key = `${o.exId}|${o.symbol}|${o.side}`;
      if (this.alerted.has(key)) continue;
      this.alerted.add(key);
      const id = String(++this.seq);
      this.orphans[id] = o;
      await this.send(
        `⚠️ Звірка: на ${o.exId} є позиція ${o.symbol.split('/')[0]} ${o.side.toUpperCase()} ${o.contracts} контр., якої немає в боті.\n` +
          'Якщо це ваша ручна угода — ігноруйте. Якщо ні — це непарна нога без хеджу, її варто закрити.',
        { inline_keyboard: [[{ text: `❎ Закрити ${o.exId} ${o.symbol.split('/')[0]}`, callback_data: `orph:${id}` }]] }
      );
    }
    // нагадуємо знову, якщо позиція зникла і з'явилась пізніше
    const present = new Set(orphans.map((o) => `${o.exId}|${o.symbol}|${o.side}`));
    for (const k of [...this.alerted]) if (!present.has(k)) this.alerted.delete(k);

    for (const m of mismatches) {
      if (this.alerted.has(m)) continue;
      this.alerted.add(m);
      await this.send(`⚠️ Звірка: розбіжність позиції — ${m}. Перевірте біржу.`);
    }

    // «Наміри», для яких на біржах нічого не лишилось і які старші за 5 хв — прибираємо
    if (pending.length && !failed.length) {
      const now = Date.now();
      const left = pending.filter((p) => now - p.ts < 5 * 60000 || this.trader.busy.has(p.symbol));
      if (left.length !== pending.length) {
        this.state.data.pending = left;
        this.state.save();
      }
    }
    return { orphans, mismatches, autoClosed, failed };
  }

  async closeOrphan(id) {
    const o = this.orphans[id];
    if (!o) return 'Ця позиція вже не актуальна. Запустіть /reconcile ще раз.';
    const ex = this.ex[o.exId];
    const r = await this.trader.withLock(() => this.trader.closeLegWithRetry(ex, o.symbol, o.side === 'short' ? 'buy' : 'sell', o.contracts, { urgent: true }));
    delete this.orphans[id];
    return r ? `✅ Закрито ${o.exId} ${o.symbol.split('/')[0]} ${o.side} ${o.contracts} контр.` : `🚨 Не вдалося закрити ${o.exId} ${o.symbol}`;
  }
}

module.exports = { Reconciler };
