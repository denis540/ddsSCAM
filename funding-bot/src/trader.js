'use strict';

const log = require('./logger');
const { currentHourlyEdge } = require('./scanner');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pct = (x, d = 3) => `${(x * 100).toFixed(d)}%`;
const fmt = (x, d = 4) => (Number.isFinite(x) ? (+x.toFixed(d)).toString() : '—');
const coinOf = (symbol) => symbol.split('/')[0];

/** Середня ціна виконання (VWAP) для обсягу baseAmount по стакану. */
function vwap(levels, baseAmount, contractSize = 1) {
  let left = baseAmount;
  let cost = 0;
  for (const [price, amount] of levels) {
    const avail = amount * contractSize;
    const take = Math.min(avail, left);
    cost += take * price;
    left -= take;
    if (left <= 1e-12) break;
  }
  if (left > 1e-9) return undefined; // стакану не вистачає
  return cost / baseAmount;
}

class Trader {
  /**
   * @param {object} cfg
   * @param {Object<string, import('./exchange').Exchange>} exchanges
   * @param {import('./state').State} state
   * @param {(t:string)=>Promise<void>} notify
   */
  constructor(cfg, exchanges, state, notify) {
    this.cfg = cfg;
    this.ex = exchanges;
    this.state = state;
    this.notify = notify;
    this.busy = new Set(); // символи, по яких зараз є угода
    this._lock = Promise.resolve();
  }

  get paper() {
    return this.cfg.mode !== 'live';
  }

  /** Послідовне виконання торгових дій (основний цикл і команди з Telegram не перетинаються). */
  withLock(fn) {
    const run = this._lock.then(fn, fn);
    this._lock = run.catch(() => {});
    return run;
  }

  hasPosition(symbol) {
    return this.state.positions.some((p) => p.symbol === symbol) || this.busy.has(symbol);
  }

  /** Бажаний обсяг входу в монетах: фіксована кількість (coins) або сума USDT / ціна. */
  targetBase(symbol, price) {
    if (this.cfg.sizeMode === 'coins') return this.cfg.coinQty[coinOf(symbol)];
    return this.cfg.positionUsdt / price;
  }

  /** Підбирає однаковий обсяг у базовій монеті, який валідний на обох біржах. */
  sizePair(symbol, S, L, price, target) {
    if (!(target > 0)) return { error: 'не задано кількість монет (/qty)' };
    let cS = S.baseToContracts(symbol, target);
    let bS = S.contractsToBase(symbol, cS);
    const cL0 = L.baseToContracts(symbol, bS);
    const bL = L.contractsToBase(symbol, cL0);
    if (bL < bS) {
      cS = S.baseToContracts(symbol, bL);
      bS = S.contractsToBase(symbol, cS);
    }
    const cL = L.baseToContracts(symbol, bS);
    const base = Math.min(bS, L.contractsToBase(symbol, cL));
    if (!(base > 0)) return { error: `кількість ${target} менша за мінімальний крок лота` };
    if (Math.abs(bS - L.contractsToBase(symbol, cL)) / base > 0.01) return { error: 'кроки лотів на біржах несумісні' };
    if (bS < S.minBaseAmount(symbol, price) || base < L.minBaseAmount(symbol, price)) {
      return { error: `менше мінімального ордера (${fmt(Math.max(S.minBaseAmount(symbol, price), L.minBaseAmount(symbol, price)))})` };
    }
    // У режимі монет не допускаємо суттєвого округлення вниз — заходимо рівно тією кількістю, яку задали
    if (this.cfg.sizeMode === 'coins' && (target - base) / target > 0.01) {
      return { error: `кількість ${target} не кратна кроку лота (вийшло б ${fmt(base, 8)})` };
    }
    return { base, cS, cL };
  }

  orderLine(side, exId, symbol, base, contracts, price, fee) {
    const ex = this.ex[exId];
    const cs = ex.market(symbol).contractSize || 1;
    const contractsTxt = cs !== 1 ? ` (${fmt(contracts, 6)} контр.)` : '';
    return (
      `${side === 'sell' ? '🔴 SELL' : '🟢 BUY'} ${fmt(base, 8)} ${coinOf(symbol)}${contractsTxt} @ ${fmt(price, 8)} на ${exId}` +
      ` ≈ ${fmt(base * price, 2)} ${this.cfg.quote}, комісія ${fmt(fee, 4)}`
    );
  }

  async tryOpen(opp) {
    const { symbol, shortEx, longEx } = opp;
    if (this.cfg.paused) return false;
    if (this.hasPosition(symbol)) return false;
    if (this.state.positions.length >= this.cfg.maxPositions) return false;
    const S = this.ex[shortEx];
    const L = this.ex[longEx];
    this.busy.add(symbol);
    try {
      const [obS, obL] = await Promise.all([S.fetchOrderBook(symbol), L.fetchOrderBook(symbol)]);
      const bidS = obS.bids[0] && obS.bids[0][0];
      const askL = obL.asks[0] && obL.asks[0][0];
      if (!bidS || !askL) return false;

      const mid = (bidS + askL) / 2;
      const sizing = this.sizePair(symbol, S, L, mid, this.targetBase(symbol, mid));
      if (sizing.error) {
        log.info(`${symbol} ${shortEx}/${longEx}: пропуск — ${sizing.error}`);
        return false;
      }
      const csS = S.market(symbol).contractSize || 1;
      const csL = L.market(symbol).contractSize || 1;
      const pxS = vwap(obS.bids, sizing.base, csS);
      const pxL = vwap(obL.asks, sizing.base, csL);
      if (!pxS || !pxL) return false;
      if ((bidS - pxS) / bidS > this.cfg.maxSlippagePct || (pxL - askL) / askL > this.cfg.maxSlippagePct) {
        log.info(`${symbol}: пропуск — слипедж більший за ліміт`);
        return false;
      }
      // Реальний basis по стакану: (ціна продажу - ціна купівлі) / ціна купівлі
      const basis = (pxS - pxL) / pxL;
      if (basis < -this.cfg.maxEntryBasisPct) {
        log.info(`${symbol}: пропуск — несприятливий basis ${pct(basis)}`);
        return false;
      }
      if (opp.expectedProfit + Math.min(basis, 0) < this.cfg.minExpectedProfitPct) return false;

      const leverage = this.cfg.leverage;
      if (!this.paper) {
        const margin = (sizing.base * mid) / leverage;
        const [fS, fL] = await Promise.all([S.freeBalance(), L.freeBalance()]);
        if (fS < margin * 1.2 || fL < margin * 1.2) {
          log.warn(`${symbol}: мало маржі (${shortEx}: ${fS.toFixed(2)}, ${longEx}: ${fL.toFixed(2)}, треба ~${(margin * 1.2).toFixed(2)})`);
          return false;
        }
        await Promise.all([
          S.prepareSymbol(symbol, leverage, this.cfg.marginMode),
          L.prepareSymbol(symbol, leverage, this.cfg.marginMode),
        ]);
      }

      const legs = await this.executeOpen(symbol, S, L, sizing, pxS, pxL);
      if (!legs) return false;

      const now = Date.now();
      const pos = {
        id: `${symbol}|${shortEx}|${longEx}|${now}`,
        symbol,
        shortEx,
        longEx,
        base: legs.base,
        leverage,
        short: { contracts: legs.short.filled, entry: legs.short.average, nextTs: opp.shortNextTs, intervalH: opp.shortIntervalH },
        long: { contracts: legs.long.filled, entry: legs.long.average, nextTs: opp.longNextTs, intervalH: opp.longIntervalH },
        openedAt: now,
        entrySpread8h: opp.spread8h,
        entryBasis: basis,
        fundingAccrued: 0,
        feesPaid: legs.fees,
        paper: this.paper,
      };
      this.state.addPosition(pos);
      await this.notify(
        `✅ ВІДКРИТО ${symbol}${this.paper ? ' [PAPER]' : ''}\n` +
          `${this.orderLine('sell', shortEx, symbol, pos.base, pos.short.contracts, pos.short.entry, legs.shortFee)}\n` +
          `${this.orderLine('buy', longEx, symbol, pos.base, pos.long.contracts, pos.long.entry, legs.longFee)}\n` +
          `Фандінг: ${shortEx} ${pct(opp.shortRate, 4)}/${opp.shortIntervalH}h, ${longEx} ${pct(opp.longRate, 4)}/${opp.longIntervalH}h\n` +
          `Спред ${pct(opp.spread8h)}/8h (APR ${pct(opp.apr, 1)}), basis ${pct(basis)}, плече x${leverage}\n` +
          `Відкрито пар: ${this.state.positions.length}/${this.cfg.maxPositions}`
      );
      return true;
    } catch (e) {
      log.error(`${symbol}: помилка відкриття: ${e.message}`);
      return false;
    } finally {
      this.busy.delete(symbol);
    }
  }

  async executeOpen(symbol, S, L, sizing, pxS, pxL) {
    if (this.paper) {
      const shortFee = sizing.base * pxS * S.takerFee(symbol);
      const longFee = sizing.base * pxL * L.takerFee(symbol);
      return {
        base: sizing.base,
        short: { filled: sizing.cS, average: pxS },
        long: { filled: sizing.cL, average: pxL },
        shortFee,
        longFee,
        fees: shortFee + longFee,
      };
    }
    // Обидві ноги паралельно — мінімізуємо час, коли позиція не захеджована
    const [rs, rl] = await Promise.allSettled([
      S.marketOrder(symbol, 'sell', sizing.cS),
      L.marketOrder(symbol, 'buy', sizing.cL),
    ]);
    if (rs.status === 'fulfilled' && rl.status === 'fulfilled') {
      const short = rs.value;
      const long = rl.value;
      short.average = short.average || pxS;
      long.average = long.average || pxL;
      const shortFee = short.fee ?? S.contractsToBase(symbol, short.filled) * short.average * S.takerFee(symbol);
      const longFee = long.fee ?? L.contractsToBase(symbol, long.filled) * long.average * L.takerFee(symbol);
      await this.rebalanceIfNeeded(symbol, S, L, short, long);
      const base = Math.min(S.contractsToBase(symbol, short.filled), L.contractsToBase(symbol, long.filled));
      return { base, short, long, shortFee, longFee, fees: shortFee + longFee };
    }
    // Одна нога не відкрилась — відкатуємо іншу
    const failed = [];
    if (rs.status === 'rejected') failed.push(`SHORT ${S.id}: ${rs.reason && rs.reason.message}`);
    if (rl.status === 'rejected') failed.push(`LONG ${L.id}: ${rl.reason && rl.reason.message}`);
    const rollback = [];
    if (rs.status === 'fulfilled') {
      const o = await this.closeLegWithRetry(S, symbol, 'buy', rs.value.filled);
      if (o) rollback.push(this.orderLine('buy', S.id, symbol, S.contractsToBase(symbol, o.filled), o.filled, o.average, o.fee));
    }
    if (rl.status === 'fulfilled') {
      const o = await this.closeLegWithRetry(L, symbol, 'sell', rl.value.filled);
      if (o) rollback.push(this.orderLine('sell', L.id, symbol, L.contractsToBase(symbol, o.filled), o.filled, o.average, o.fee));
    }
    await this.notify(`⚠️ ${symbol}: не вдалося відкрити пару, відкат.\n${failed.join('\n')}${rollback.length ? `\nВідкат:\n${rollback.join('\n')}` : ''}`);
    return undefined;
  }

  /** Якщо біржі виконали різний обсяг (часткове виконання) — зрізаємо більшу ногу. */
  async rebalanceIfNeeded(symbol, S, L, short, long) {
    const bS = S.contractsToBase(symbol, short.filled);
    const bL = L.contractsToBase(symbol, long.filled);
    const diff = bS - bL;
    if (Math.abs(diff) / Math.max(bS, bL) < 0.005) return;
    try {
      const [ex, side, leg] = diff > 0 ? [S, 'buy', short] : [L, 'sell', long];
      const c = ex.baseToContracts(symbol, Math.abs(diff));
      if (c > 0) {
        const o = await ex.marketOrder(symbol, side, c, { reduceOnly: true });
        leg.filled -= c;
        await this.notify(`⚖️ ${symbol}: ноги виконались різним обсягом, вирівнювання\n${this.orderLine(side, ex.id, symbol, ex.contractsToBase(symbol, c), c, o.average, o.fee)}`);
      }
    } catch (e) {
      await this.notify(`⚠️ ${symbol}: не вдалося зрівняти ноги: ${e.message}`);
    }
  }

  async closeLegWithRetry(exchange, symbol, side, contracts, attempts = 4) {
    for (let i = 1; i <= attempts; i++) {
      try {
        return await exchange.marketOrder(symbol, side, contracts, { reduceOnly: true });
      } catch (e) {
        log.error(`${exchange.id} ${symbol}: закриття ноги, спроба ${i}/${attempts}: ${e.message}`);
        await sleep(1000 * 2 ** i);
      }
    }
    await this.notify(`🚨 ${symbol}: НЕ ВДАЛОСЯ ЗАКРИТИ ногу на ${exchange.id}! Потрібне ручне втручання.`);
    return undefined;
  }

  /** Нарахування фандінгу при настанні часу виплати (для paper — основний облік, для live — оцінка). */
  accrueFunding(ratesByExchange) {
    const now = Date.now();
    let changed = false;
    for (const pos of this.state.positions) {
      for (const [legKey, exId, sign] of [['short', pos.shortEx, 1], ['long', pos.longEx, -1]]) {
        const leg = pos[legKey];
        const r = ratesByExchange[exId] && ratesByExchange[exId][pos.symbol];
        if (!r) continue;
        if (!leg.nextTs) leg.nextTs = r.nextTs;
        while (leg.nextTs && now >= leg.nextTs) {
          const mark = r.mark || leg.entry;
          const rate = leg.lastRate ?? r.rate;
          const payment = sign * rate * pos.base * mark; // short отримує +rate, long платить
          pos.fundingAccrued += payment;
          this.state.addDaily('funding', payment);
          log.info(`${pos.symbol} ${legKey}@${exId}: фандінг ${payment >= 0 ? '+' : ''}${payment.toFixed(4)} ${this.cfg.quote}`);
          leg.nextTs = r.nextTs && r.nextTs > leg.nextTs ? r.nextTs : leg.nextTs + (r.intervalH || leg.intervalH || 8) * 3600000;
          changed = true;
        }
        // Запам'ятовуємо ставку, яка буде застосована на найближчій виплаті
        leg.lastRate = r.rate;
        leg.intervalH = r.intervalH;
      }
    }
    if (changed) this.state.save();
  }

  /** Перевірка умов виходу для всіх позицій. */
  async manage(ratesByExchange) {
    for (const pos of [...this.state.positions]) {
      const edge = currentHourlyEdge(ratesByExchange, pos);
      const heldH = (Date.now() - pos.openedAt) / 3600000;
      let reason;
      if (pos.closeError) reason = `повторна спроба закриття (${pos.closeError})`;
      else if (edge !== undefined && edge * 8 < this.cfg.exitSpread8h) reason = `спред впав до ${pct(edge * 8)}/8h`;
      else if (heldH >= this.cfg.maxHoldHours) reason = `макс. час утримання ${heldH.toFixed(1)}h`;
      else reason = await this.liquidationRisk(pos, ratesByExchange);
      if (reason) await this.closePair(pos, reason);
    }
  }

  async liquidationRisk(pos, ratesByExchange) {
    const buf = this.cfg.liqBufferPct;
    if (this.paper) {
      // Груба модель ізольованої маржі: ліквідація при русі ~1/leverage
      const lev = pos.leverage || this.cfg.leverage;
      const markS = ratesByExchange[pos.shortEx]?.[pos.symbol]?.mark;
      const markL = ratesByExchange[pos.longEx]?.[pos.symbol]?.mark;
      if (markS) {
        const liq = pos.short.entry * (1 + 1 / lev);
        if ((liq - markS) / markS < buf) return `SHORT ${pos.shortEx} близько до ліквідації`;
      }
      if (markL) {
        const liq = pos.long.entry * (1 - 1 / lev);
        if ((markL - liq) / markL < buf) return `LONG ${pos.longEx} близько до ліквідації`;
      }
      return undefined;
    }
    for (const [exId, side] of [[pos.shortEx, 'short'], [pos.longEx, 'long']]) {
      try {
        const p = await this.ex[exId].fetchPosition(pos.symbol);
        if (!p) return `позиція ${side} на ${exId} зникла (ліквідація/ручне закриття?)`;
        if (p.liquidationPrice && p.markPrice) {
          const dist = Math.abs(p.markPrice - p.liquidationPrice) / p.markPrice;
          if (dist < buf) return `${side} ${exId}: до ліквідації ${pct(dist, 1)}`;
        }
      } catch (e) {
        log.warn(`${exId} fetchPosition ${pos.symbol}: ${e.message}`);
      }
    }
    return undefined;
  }

  /** Закриває пару тією ж кількістю монет, якою відкривали. */
  async closePair(pos, reason) {
    const S = this.ex[pos.shortEx];
    const L = this.ex[pos.longEx];
    let exitS;
    let exitL;
    let feeS;
    let feeL;
    try {
      if (this.paper) {
        const [obS, obL] = await Promise.all([S.fetchOrderBook(pos.symbol), L.fetchOrderBook(pos.symbol)]);
        exitS = vwap(obS.asks, pos.base, S.market(pos.symbol).contractSize || 1) || obS.asks[0][0];
        exitL = vwap(obL.bids, pos.base, L.market(pos.symbol).contractSize || 1) || obL.bids[0][0];
        feeS = pos.base * exitS * S.takerFee(pos.symbol);
        feeL = pos.base * exitL * L.takerFee(pos.symbol);
      } else {
        // Нога, закрита на попередній (частково невдалій) спробі, повторно не закривається
        const closeLeg = (ex, side, leg) =>
          leg.contracts > 0
            ? this.closeLegWithRetry(ex, pos.symbol, side, leg.contracts)
            : Promise.resolve({ average: leg.exit, fee: leg.exitFee || 0 });
        const [rs, rl] = await Promise.all([closeLeg(S, 'buy', pos.short), closeLeg(L, 'sell', pos.long)]);
        if (rs && pos.short.contracts > 0) Object.assign(pos.short, { contracts: 0, exit: rs.average, exitFee: rs.fee });
        if (rl && pos.long.contracts > 0) Object.assign(pos.long, { contracts: 0, exit: rl.average, exitFee: rl.fee });
        if (!rs || !rl) {
          // Часткове закриття: позицію лишаємо у стані, щоб не загубити незакриту ногу
          pos.closeError = reason;
          this.state.save();
          return undefined;
        }
        exitS = rs.average || pos.short.entry;
        exitL = rl.average || pos.long.entry;
        feeS = rs.fee ?? pos.base * exitS * S.takerFee(pos.symbol);
        feeL = rl.fee ?? pos.base * exitL * L.takerFee(pos.symbol);
      }
    } catch (e) {
      log.error(`${pos.symbol}: помилка закриття: ${e.message}`);
      return undefined;
    }
    const closeFees = feeS + feeL;
    const pricePnl = (pos.short.entry - exitS) * pos.base + (exitL - pos.long.entry) * pos.base;
    const pnl = pricePnl + pos.fundingAccrued - pos.feesPaid - closeFees;
    const closed = this.state.closePosition(pos.id, { exitShort: exitS, exitLong: exitL, pricePnl, closeFees, pnl, reason });
    const heldH = (Date.now() - pos.openedAt) / 3600000;
    const s = this.state.data.stats;
    await this.notify(
      `❎ ЗАКРИТО ${pos.symbol}${this.paper ? ' [PAPER]' : ''} — ${reason}\n` +
        `${this.orderLine('buy', pos.shortEx, pos.symbol, pos.base, pos.short.contracts || S.baseToContracts(pos.symbol, pos.base), exitS, feeS)}\n` +
        `${this.orderLine('sell', pos.longEx, pos.symbol, pos.base, pos.long.contracts || L.baseToContracts(pos.symbol, pos.base), exitL, feeL)}\n` +
        `Утримання: ${heldH.toFixed(1)} год\n` +
        `Різниця цін: ${fmt(pricePnl)} | Фандінг: ${fmt(pos.fundingAccrued)} | Комісії: ${fmt(pos.feesPaid + closeFees)}\n` +
        `${pnl >= 0 ? '💰' : '🔻'} PnL угоди: ${fmt(pnl)} ${this.cfg.quote}\n` +
        `Загальний PnL: ${fmt(s.realizedPnl)} ${this.cfg.quote} (${s.trades} угод)`
    );
    return closed;
  }
}

module.exports = { Trader, vwap };
