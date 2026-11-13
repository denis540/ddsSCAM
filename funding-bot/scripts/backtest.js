'use strict';
// Перевірка стратегії на історії ставок: npm run backtest -- --days 14 --coins 30
const cfg = require('../src/config');
const { Exchange } = require('../src/exchange');
const { runBacktest } = require('../src/backtest');

const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? Number(process.argv[i + 1]) : def;
};

(async () => {
  const exchanges = {};
  for (const id of cfg.exchanges) {
    try {
      const ex = new Exchange(id, cfg.credentials[id], { quote: cfg.quote, defaultTakerFee: cfg.defaultTakerFee });
      await ex.init();
      await ex.loadTickers().catch(() => {});
      exchanges[id] = ex;
    } catch (e) {
      console.error(`${id}: ${e.message}`);
    }
  }
  if (Object.keys(exchanges).length < 2) throw new Error('Потрібно мінімум 2 біржі');
  const r = await runBacktest({
    exchanges, cfg, days: arg('days', 7), maxCoins: arg('coins', 25),
    onProgress: (d, n) => process.stdout.write(`\r${d}/${n} монет`),
  });
  console.log(`\n\n${r.text}`);
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
