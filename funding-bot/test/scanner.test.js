'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { findOpportunities } = require('../src/scanner');
const { parseIntervalHours } = require('../src/exchange');

const cfg = {
  minSpread8h: 0.0005, minExpectedProfitPct: 0.001, holdHoursEstimate: 24, maxEntryBasisPct: 0.0015,
  maxAbsFundingRate: 0.02, minMinutesToFunding: 0, whitelist: [], blacklist: [], defaultTakerFee: 0.0005,
};

test('шорт там, де фандінг вищий; нормалізація інтервалів', () => {
  const rates = {
    a: { 'X/USDT:USDT': { rate: 0.001, intervalH: 4, mark: 10 } },   // 0.025%/h
    b: { 'X/USDT:USDT': { rate: -0.0002, intervalH: 8, mark: 10 } }, // -0.0025%/h
  };
  const [o] = findOpportunities(rates, cfg);
  assert.equal(o.shortEx, 'a');
  assert.equal(o.longEx, 'b');
  assert.ok(Math.abs(o.spread8h - (0.001 * 2 + 0.0002)) < 1e-12);
  // 24h * 0.0275%/h = 0.66%, мінус 4 тейкери 0.2% = 0.46%
  assert.ok(Math.abs(o.expectedProfit - (0.0022 / 8 * 24 - 0.002)) < 1e-12);
});

test('однакові ставки на різних інтервалах — не арбітраж', () => {
  const rates = {
    a: { 'X/USDT:USDT': { rate: 0.0004, intervalH: 8 } },
    b: { 'X/USDT:USDT': { rate: 0.0001, intervalH: 2 } },
  };
  assert.equal(findOpportunities(rates, cfg).length, 0);
});

test('фільтри: blacklist, аномальні ставки, несприятливий basis', () => {
  const rates = {
    a: { 'X/USDT:USDT': { rate: 0.003, intervalH: 8, mark: 9.9 } },
    b: { 'X/USDT:USDT': { rate: 0, intervalH: 8, mark: 10 } },
  };
  assert.equal(findOpportunities(rates, cfg).length, 0, 'basis -1% має відсікатись');
  rates.a['X/USDT:USDT'].mark = 10;
  assert.equal(findOpportunities(rates, cfg).length, 1);
  assert.equal(findOpportunities(rates, { ...cfg, blacklist: ['X'] }).length, 0);
  rates.a['X/USDT:USDT'].rate = 0.05;
  assert.equal(findOpportunities(rates, cfg).length, 0);
});

test('parseIntervalHours', () => {
  assert.equal(parseIntervalHours({ interval: '4h' }), 4);
  assert.equal(parseIntervalHours({ symbol: 's' }, { s: 1 }), 1);
  assert.equal(parseIntervalHours({ info: { funding_interval: 28800 } }), 8);
  assert.equal(parseIntervalHours({ fundingTimestamp: 1e12, nextFundingTimestamp: 1e12 + 2 * 3600e3 }), 2);
  assert.equal(parseIntervalHours({}), 8);
});
