'use strict';

const log = require('./logger');
const { currentHourlyEdge } = require('./scanner');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pct = (x, d = 3) => `${(x * 100).toFixed(d)}%`;

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
    this.paper = cfg.mode !== 'live';
    this.busy = new Set(); // символи, по яких зараз є угода
  }

  hasPosition(symbol) {
    return this.state.positions.some((p) => p.symbol === symbol) || this.busy.has(symbol);
  }

  /** Підбирає однаковий обсяг у базовій монеті, який валідний на обох біржах. */
  sizePair(symbol, S, L, price) {
    const target = this.cfg.positionUsdt / price;
    let cS = S.baseToContracts(symbol, target);
    let bS = S.contractsToBase(symbol, cS);
    let cL = L.baseToContracts(symbol, bS);
    let bL = L.contractsToBase(symbol, cL);
    if (bL < bS) {
      cS = S.baseToContracts(symbol, bL);
      bS = S.contractsToBase(symbol, cS);
    }
    const baseAmt = Math.min(bS, bL);
    if (!(baseAmt > 0)) return undefined;
    if (Math.abs(bS - bL) / baseAmt > 0.01) return undefined; // кроки лотів несумісні — хедж буде кривий
    if (bS < S.minBaseAmount(symbol, price) || bL < L.minBaseAmount(symbol, price)) return undefined;
    return { base: baseAmt, cS, cL };
  }

  async tryOpen(opp) {
    const { symbol, shortEx, longEx } = opp;
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

      const sizing = this.sizePair(symbol, S, L, (bidS + askL) / 2);
      if (!sizing) {
        log.debug(`${symbol}: не вдалося підібрати розмір для ${shortEx}/${longEx}`);
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
      // Перерахунок очікуваного профіту з урахуванням реального basis
      if (opp.expectedProfit + Math.min(basis, 0) < this.cfg.minExpectedProfitPct) return false;

      if (!this.paper) {
        const margin = this.cfg.positionUsdt / this.cfg.leverage;
        const [fS, fL] = await Promise.all([S.freeBalance(), L.freeBalance()]);
        if (fS < margin * 1.2 || fL < margin * 1.2) {
          log.warn(`${symbol}: мало маржі (${shortEx}: ${fS.toFixed(2)}, ${longEx}: ${fL.toFixed(2)}, треба ~${(margin * 1.2).toFixed(2)})`);
          return false;
        }
        await Promise.all([
          S.prepareSymbol(symbol, this.cfg.leverage, this.cfg.marginMode),
          L.prepareSymbol(symbol, this.cfg.leverage, this.cfg.marginMode),
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
        base: sizing.base,
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
        `✅ ВІДКРИТО ${symbol}\nSHORT ${shortEx} @ ${pos.short.entry} (фандінг ${pct(opp.shortRate, 4)}/${opp.shortIntervalH}h)\n` +
          `LONG ${longEx} @ ${pos.long.entry} (фандінг ${pct(opp.longRate, 4)}/${opp.longIntervalH}h)\n` +
          `Обсяг ${sizing.base} ≈ ${(sizing.base * pxL).toFixed(2)} ${this.cfg.quote}, спред ${pct(opp.spread8h)}/8h, APR ${pct(opp.apr, 1)}` +
          (this.paper ? '\n[PAPER]' : '')
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
      const fees = sizing.base * (pxS * S.takerFee(symbol) + pxL * L.takerFee(symbol));
      return {
        short: { filled: sizing.cS, average: pxS },
        long: { filled: sizing.cL, average: pxL },
        fees,
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
      const fees =
        (short.fee ?? S.contractsToBase(symbol, short.filled) * (short.average || pxS) * S.takerFee(symbol)) +
        (long.fee ?? L.contractsToBase(symbol, long.filled) * (long.average || pxL) * L.takerFee(symbol));
      short.average = short.average || pxS;
      long.average = long.average || pxL;
      await this.rebalanceIfNeeded(symbol, S, L, short, long);
      return { short, long, fees };
    }
    // Одна нога не відкрилась — відкатуємо іншу
    const failed = [];
    if (rs.status === 'rejected') failed.push(`SHORT ${S.id}: ${rs.reason && rs.reason.message}`);
    if (rl.status === 'rejected') failed.push(`LONG ${L.id}: ${rl.reason && rl.reason.message}`);
    if (rs.status === 'fulfilled') await this.closeLegWithRetry(S, symbol, 'buy', rs.value.filled);
    if (rl.status === 'fulfilled') await this.closeLegWithRetry(L, symbol, 'sell', rl.value.filled);
    await this.notify(`⚠️ ${symbol}: не вдалося відкрити пару, відкат.\n${failed.join('\n')}`);
    return undefined;
  }

  /** Якщо біржі виконали різний обсяг (часткове виконання) — зрізаємо більшу ногу. */
  async rebalanceIfNeeded(symbol, S, L, short, long) {
    const bS = S.contractsToBase(symbol, short.filled);
    const bL = L.contractsToBase(symbol, long.filled);
    const diff = bS - bL;
    if (Math.abs(diff) / Math.max(bS, bL) < 0.005) return;
    try {
      if (diff > 0) {
        const c = S.baseToContracts(symbol, diff);
        if (c > 0) {
          await S.marketOrder(symbol, 'buy', c, { reduceOnly: true });
          short.filled -= c;
        }
      } else {
        const c = L.baseToContracts(symbol, -diff);
        if (c > 0) {
          await L.marketOrder(symbol, 'sell', c, { reduceOnly: true });
          long.filled -= c;
        }
      }
      log.warn(`${symbol}: ребаланс ніг (різниця ${diff})`);
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
          const payment = sign * (leg.lastRate ?? r.rate) * pos.base * mark; // short отримує +rate, long платить
          pos.fundingAccrued += payment;
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
      if (edge !== undefined && edge * 8 < this.cfg.exitSpread8h) reason = `спред впав до ${pct(edge * 8)}/8h`;
      else if (heldH >= this.cfg.maxHoldHours) reason = `макс. час утримання ${heldH.toFixed(1)}h`;
      else reason = await this.liquidationRisk(pos, ratesByExchange);
      if (reason) await this.closePair(pos, reason);
    }
  }

  async liquidationRisk(pos, ratesByExchange) {
    const buf = this.cfg.liqBufferPct;
    if (this.paper) {
      // Груба модель ізольованої маржі: ліквідація при русі ~1/leverage
      const lev = this.cfg.leverage;
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

  async closePair(pos, reason) {
    const S = this.ex[pos.shortEx];
    const L = this.ex[pos.longEx];
    let exitS;
    let exitL;
    let closeFees = 0;
    try {
      if (this.paper) {
        const [obS, obL] = await Promise.all([S.fetchOrderBook(pos.symbol), L.fetchOrderBook(pos.symbol)]);
        exitS = vwap(obS.asks, pos.base, S.market(pos.symbol).contractSize || 1) || obS.asks[0][0];
        exitL = vwap(obL.bids, pos.base, L.market(pos.symbol).contractSize || 1) || obL.bids[0][0];
        closeFees = pos.base * (exitS * S.takerFee(pos.symbol) + exitL * L.takerFee(pos.symbol));
      } else {
        // Нога, закрита на попередній (частково невдалій) спробі, повторно не закривається
        const closeLeg = (ex, side, leg) =>
          leg.contracts > 0
            ? this.closeLegWithRetry(ex, pos.symbol, side, leg.contracts)
            : Promise.resolve({ average: leg.exit, fee: 0 });
        const [rs, rl] = await Promise.all([closeLeg(S, 'buy', pos.short), closeLeg(L, 'sell', pos.long)]);
        if (!rs || !rl) {
          // Часткове закриття: позицію лишаємо у стані, щоб не загубити незакриту ногу
          if (rs && pos.short.contracts > 0) Object.assign(pos.short, { contracts: 0, exit: rs.average });
          if (rl && pos.long.contracts > 0) Object.assign(pos.long, { contracts: 0, exit: rl.average });
          pos.closeError = reason;
          this.state.save();
          return;
        }
        exitS = rs.average || pos.short.entry;
        exitL = rl.average || pos.long.entry;
        closeFees =
          (rs.fee ?? pos.base * exitS * S.takerFee(pos.symbol)) + (rl.fee ?? pos.base * exitL * L.takerFee(pos.symbol));
      }
    } catch (e) {
      log.error(`${pos.symbol}: помилка закриття: ${e.message}`);
      return;
    }
    const pricePnl = (pos.short.entry - exitS) * pos.base + (exitL - pos.long.entry) * pos.base;
    const pnl = pricePnl + pos.fundingAccrued - pos.feesPaid - closeFees;
    this.state.closePosition(pos.id, { exitShort: exitS, exitLong: exitL, pricePnl, closeFees, pnl, reason });
    await this.notify(
      `❎ ЗАКРИТО ${pos.symbol} (${pos.shortEx}/${pos.longEx}) — ${reason}\n` +
        `Ціна: ${pricePnl.toFixed(4)}, фандінг: ${pos.fundingAccrued.toFixed(4)}, комісії: ${(pos.feesPaid + closeFees).toFixed(4)}\n` +
        `PnL: ${pnl.toFixed(4)} ${this.cfg.quote}` +
        (this.paper ? ' [PAPER]' : '')
    );
  }
}

module.exports = { Trader, vwap };
