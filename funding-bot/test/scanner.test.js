'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { planWindows, dueWindows } = require('../src/scanner');
const { parseIntervalHours } = require('../src/exchange');

const T = 1_700_000_000_000;
const M = 60_000;
const H = 3_600_000;
const S = 'X/USDT:USDT';
const cfg = {
  minFunding: 0.001, minProfit: 0, maxWindowHours: 8, lookaheadHours: 8, allowEstimated: true, entryMinSec: 20,
  entryBeforeSec: 120, maxEntryBasisPct: 0.0015, maxAbsFundingRate: 0.1, whitelist: [], blacklist: [], defaultTakerFee: 0.0005,
};
const r = (rate, nextTs, intervalH = 8, mark = 10) => ({ rate, nextTs, intervalH, mark });
const near = (a, b) => Math.abs(a - b) < 1e-12;
const best = (wins, f = () => true) => wins.filter(f).sort((a, b) => b.net - a.net)[0];

test('виплата одночасно: OKX 3%, Binance 1% => short OKX, long Binance, фандінг 2%', () => {
  const w = best(planWindows({ okx: { [S]: r(0.03, T + 2 * M) }, binance: { [S]: r(0.01, T + 2 * M) } }, cfg, undefined, T));
  assert.equal(w.shortEx, 'okx');
  assert.equal(w.longEx, 'binance');
  assert.ok(near(w.funding, 0.02));
  assert.ok(near(w.net, 0.02 - 0.002)); // 4 тейкери по 0.05%
  assert.equal(w.startTs, T + 2 * M);
  assert.equal(w.events.length, 2);
});

test('різний час: OKX 3% через 1 год, Binance 1% через 2 год => беремо лише виплату OKX (3%)', () => {
  const wins = planWindows({ okx: { [S]: r(0.03, T + H) }, binance: { [S]: r(0.01, T + 2 * H) } }, cfg, undefined, T);
  const w = best(wins);
  assert.equal(w.shortEx, 'okx');
  assert.ok(near(w.funding, 0.03));
  assert.equal(w.startTs, T + H);
  assert.equal(w.endTs, T + H); // не тримаємо до виплати Binance, бо там би заплатили 1%
  assert.deepEqual(w.events.map((e) => e.ex), ['okx']);
});

test('різний час, обидві виплати на нашу користь => тримаємо через обидві', () => {
  // OKX +3% через 1 год (шорт отримує), Binance −1% через 2 год (лонг отримує)
  const w = best(planWindows({ okx: { [S]: r(0.03, T + H) }, binance: { [S]: r(-0.01, T + 2 * H) } }, cfg, undefined, T));
  assert.equal(w.startTs, T + H);
  assert.equal(w.endTs, T + 2 * H);
  assert.ok(near(w.funding, 0.04));
});

test('від\'ємна ставка: LONG на біржі з від\'ємним фандінгом', () => {
  const w = best(planWindows({ binance: { [S]: r(-0.02, T + 5 * M) }, okx: { [S]: r(0.0001, T + 5 * M) } }, cfg, undefined, T));
  assert.equal(w.longEx, 'binance');
  assert.equal(w.shortEx, 'okx');
  assert.ok(near(w.funding, 0.0201));
});

test('інтервали 1h vs 8h: кілька виплат швидшої біржі у вікні', () => {
  const rates = { bybit: { [S]: r(0.005, T + 5 * M, 1) }, binance: { [S]: r(0.001, T + 4 * H + 5 * M, 8) } };
  const w = best(planWindows(rates, cfg, undefined, T), (x) => x.shortEx === 'bybit' && x.startTs === T + 5 * M);
  // 0.5% щогодини з 00:05 до 04:05 (5 виплат), мінус 0.1% на лонгу binance о 04:05
  assert.equal(w.endTs, T + 4 * H + 5 * M);
  assert.ok(near(w.funding, 0.005 * 5 - 0.001));
  assert.ok(w.estimated);

  const strict = best(planWindows(rates, { ...cfg, allowEstimated: false }, undefined, T), (x) => x.shortEx === 'bybit');
  assert.ok(near(strict.funding, 0.005)); // лише одна відома виплата
  assert.equal(strict.events.length, 1);

  const single = planWindows(rates, { ...cfg, maxWindowHours: 0 }, undefined, T);
  assert.ok(single.every((x) => x.startTs === x.endTs));
});

test('поріг minFunding і комісії', () => {
  const rates = { okx: { [S]: r(0.002, T + 2 * M) }, binance: { [S]: r(0.0005, T + 2 * M) } };
  const loose = { ...cfg, minProfit: -1 };
  assert.equal(planWindows(rates, { ...loose, minFunding: 0.002 }, undefined, T).length, 0); // 0.15% < 0.2%
  assert.equal(planWindows(rates, { ...loose, minFunding: 0.001 }, undefined, T).length, 1);
  assert.equal(planWindows(rates, { ...cfg, minFunding: 0.001 }, undefined, T).length, 0); // 0.15% − 0.2% комісій < 0 — не заходимо
});

test('фільтри: blacklist, аномалії, несприятлива різниця цін', () => {
  const rates = { a: { [S]: r(0.01, T + 2 * M, 8, 9.9) }, b: { [S]: r(0, T + 2 * M, 8, 10) } };
  assert.equal(planWindows(rates, cfg, undefined, T).length, 0, 'basis −1% відсікається');
  rates.a[S].mark = 10;
  assert.equal(planWindows(rates, cfg, undefined, T).length, 1);
  assert.equal(planWindows(rates, { ...cfg, blacklist: ['X'] }, undefined, T).length, 0);
  assert.equal(planWindows(rates, { ...cfg, maxAbsFundingRate: 0.005 }, undefined, T).length, 0);
});

test('dueWindows: заходимо лише за entryBeforeSec..entryMinSec до виплати', () => {
  const wins = [{ startTs: T + 5 * M }, { startTs: T + 110_000 }, { startTs: T + 10_000 }];
  assert.deepEqual(dueWindows(wins, cfg, T).map((w) => w.startTs), [T + 110_000]);
});

test('parseIntervalHours', () => {
  assert.equal(parseIntervalHours({ interval: '4h' }), 4);
  assert.equal(parseIntervalHours({ symbol: 's' }, { s: 1 }), 1);
  assert.equal(parseIntervalHours({ info: { funding_interval: 28800 } }), 8);
  assert.equal(parseIntervalHours({ fundingTimestamp: 1e12, nextFundingTimestamp: 1e12 + 2 * 3600e3 }), 2);
  assert.equal(parseIntervalHours({}), 8);
});

test('вікно не починається з виплати проти нас: KAVA binance −0.32%/4h (шорт платить) о 14:00, bybit −1.13%/8h о 18:00', () => {
  // шорт binance о 14:00 і 18:00 платить 0.32%, лонг bybit о 18:00 отримує 1.13%
  const wins = planWindows({ binance: { [S]: r(-0.0032, T + 2 * M, 4) }, bybit: { [S]: r(-0.0113, T + 2 * M + 4 * H, 8) } }, cfg, undefined, T);
  const mine = wins.filter((w) => w.shortEx === 'binance' && w.longEx === 'bybit');
  assert.ok(mine.length, 'вікно перед 18:00 лишається');
  assert.ok(mine.every((w) => w.startTs === T + 2 * M + 4 * H), 'вхід лише перед 18:00, не о 14:00');
  assert.ok(near(mine[0].funding, 0.0113 - 0.0032));
});
