'use strict';
/**
 * Діагностика бота на реальних біржах. Нічого не торгує.
 *
 *   npm run check                      — підключення, ставки, стакани, сканер, годинник (без ключів теж)
 *   npm run check -- --selftest        — + самоперевірка бірж з ключами (лімітний ордер, що НЕ виконається)
 *   npm run check -- --backtest 7      — + перевірка на історії ставок за 7 днів
 *
 * Звіт: data/check-report.txt (без ключів і підписів — можна надсилати).
 */
const fs = require('fs');
const path = require('path');
const cfg = require('../src/config');
const { Exchange } = require('../src/exchange');
const { KeyStore } = require('../src/keys');
const { planWindows } = require('../src/scanner');
const { runBacktest } = require('../src/backtest');
const { sanitize } = require('../src/telegram');
const { Settings } = require('../src/settings');
const { CoinRegistry } = require('../src/coins');
const { untrustedRates } = require('../src/exchanges-meta');

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(`--${n}`);
const arg = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? Number(argv[i + 1]) : d;
};
const lines = [];
const out = (t = '') => {
  const s = sanitize(t);
  lines.push(s);
  console.log(s);
};
const pct = (x, d = 4) => `${(x * 100).toFixed(d)}%`;
const median = (a) => {
  const s = [...a].sort((x, y) => x - y);
  return s.length ? s[Math.floor(s.length / 2)] : undefined;
};
const timed = async (fn) => {
  const t = Date.now();
  const r = await fn();
  return [r, Date.now() - t];
};

(async () => {
  // ті самі налаштування, що й у бота: .env + змінене через Telegram (data/settings.json)
  try {
    new Settings(cfg, cfg.settingsFile);
  } catch (e) {
    console.warn(`data/settings.json не прочитано: ${e.message}`);
  }
  out(`ДІАГНОСТИКА funding-bot — ${new Date().toISOString()}`);
  out(`Node ${process.version}, ${process.platform}; режим ${cfg.mode}${cfg.sandbox ? ' (SANDBOX)' : ''}`);
  out(`Біржі в налаштуваннях: ${cfg.exchanges.join(', ')}`);
  out(`Пороги: фандінг ≥ ${pct(cfg.minFunding, 2)}, чистий ≥ ${pct(cfg.minProfit, 2)}; сума ${cfg.maxTradeUsdt} × плече ${cfg.leverage}\n`);

  let keys;
  try {
    keys = new KeyStore(cfg.credentials, cfg.keysFile, cfg.keysSecret);
  } catch (e) {
    out(`⚠️ Ключі з data/keys.json не прочитано: ${e.message}`);
    keys = new KeyStore(cfg.credentials, null);
  }

  // 1) Підключення
  out('== 1. Підключення до бірж ==');
  const ex = {};
  for (const id of cfg.exchanges) {
    try {
      const e = new Exchange(id, keys.get(id), { quote: cfg.quote, defaultTakerFee: cfg.defaultTakerFee });
      if (cfg.sandbox && !e.enableSandbox(cfg.testEnv[id])) {
        out(`⚪ ${e.title}: тестової мережі немає (SANDBOX)`);
        continue;
      }
      const [, ms] = await timed(() => e.init());
      const mults = Object.entries(e.mult).filter(([, m]) => m !== 1).map(([s, m]) => `${s.split('/')[0]}×${m}`);
      out(`🟢 ${e.title}: ${e.perpSymbols().length} монет, ${ms} мс, ключ: ${e.hasKeys ? 'є' : 'немає'}` +
        (mults.length ? `\n   монети з множником: ${mults.slice(0, 8).join(', ')}${mults.length > 8 ? ` …(+${mults.length - 8})` : ''}` : ''));
      ex[id] = e;
    } catch (e) {
      out(`🔴 ${id}: ${e.message.slice(0, 200)}`);
      if (/451|restricted|not available|forbidden|403/i.test(e.message)) out('   ↳ схоже на блокування за регіоном/IP (VPN або сервер в іншій країні)');
    }
  }
  if (Object.keys(ex).length < 2) {
    out('\n⛔ Менше 2 бірж на зв\'язку — далі перевіряти нічого. Перевірте інтернет, VPN, регіон.');
    return;
  }

  // 2) Годинник
  out('\n== 2. Годинник ==');
  for (const e of Object.values(ex)) {
    try {
      const off = await e.clockOffset();
      if (off !== undefined) out(`${e.id}: ${off > 0 ? '+' : ''}${Math.round(off)} мс${Math.abs(off) > cfg.maxClockSkewMs ? '  ⚠️ увімкніть синхронізацію часу' : ''}`);
    } catch (err) {
      out(`${e.id}: ${err.message.slice(0, 120)}`);
    }
  }

  // 3) Ставки фандінгу
  out('\n== 3. Ставки фандінгу ==');
  const rates = {};
  for (const e of Object.values(ex)) {
    try {
      const [r, ms] = await timed(() => e.fetchFundingRates());
      rates[e.id] = r;
      const vals = Object.values(r);
      const iv = {};
      for (const x of vals) iv[`${x.intervalH}h`] = (iv[`${x.intervalH}h`] || 0) + 1;
      const noTime = vals.filter((x) => !x.nextTs).length;
      const next = vals.map((x) => x.nextTs).filter(Boolean).sort((a, b) => a - b)[0];
      const top = vals.length ? Object.entries(r).sort((a, b) => Math.abs(b[1].rate) - Math.abs(a[1].rate))[0] : undefined;
      out(`${e.id}: ${vals.length} монет за ${ms} мс; інтервали ${JSON.stringify(iv)}; без часу виплати: ${noTime}` +
        `${next ? `; найближча виплата ${new Date(next).toISOString().slice(11, 16)} UTC` : ''}` +
        `${top ? `; найбільша ставка ${top[0].split('/')[0]} ${pct(top[1].rate)}` : ''}`);
    } catch (err) {
      out(`${e.id}: ❌ ${err.message.slice(0, 200)}`);
    }
  }

  // 4) Масштаб ставок: кожна біржа vs медіана інших (ловить помилки масштабу, напр. Kraken)
  out('\n== 4. Масштаб ставок між біржами (за годину, медіана по спільних монетах) ==');
  const hourly = (r) => r.rate / (r.intervalH || 8);
  for (const id of Object.keys(rates)) {
    const ratios = [];
    for (const [sym, r] of Object.entries(rates[id])) {
      const others = Object.keys(rates).filter((o) => o !== id && rates[o][sym]).map((o) => hourly(rates[o][sym]));
      const m = median(others);
      if (others.length && Math.abs(m) > 2e-6 && Math.abs(hourly(r)) > 2e-6) ratios.push(Math.abs(hourly(r) / m));
    }
    const mr = median(ratios);
    if (mr === undefined || ratios.length < 15) out(`${id}: замало спільних монет із ненульовою ставкою (${ratios.length}) для висновку`);
    else out(`${id}: ${ratios.length} монет, медіана співвідношення ${mr.toFixed(2)}${mr > 5 || mr < 0.2 ? '  ⚠️ ПІДОЗРІЛО — можливо, ставка в іншому масштабі' : ' (норма ≈ 1)'}`);
  }

  // 4б) Kraken: сирі поля, щоб з'ясувати масштаб ставки (ставка / ціна; прогноз; фактичні виплати з історії)
  if (ex.kraken) {
    out('\n== 4б. Kraken: діагностика масштабу ставки ==');
    try {
      const raw = await ex.kraken.client.fetchFundingRates();
      for (const coin of ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE']) {
        const sym = `${coin}/USDT:USDT`;
        const nat = ex.kraken.native[sym];
        const fr = nat && raw[nat];
        if (!fr) continue;
        const info = fr.info || {};
        let hist = '';
        try {
          const h = await ex.kraken.client.fetchFundingRateHistory(nat, Date.now() - 6 * 3600000);
          hist = h.slice(-3).map((x) => `${new Date(x.timestamp).toISOString().slice(11, 16)} ${pct(x.fundingRate, 5)}`).join(', ');
        } catch (e) {
          hist = `історія: ${e.message.slice(0, 80)}`;
        }
        const others = Object.keys(rates).filter((o) => o !== 'kraken' && rates[o][sym]).map((o) => `${o} ${pct(rates[o][sym].rate / (rates[o][sym].intervalH || 8), 5)}/год`);
        out(`${coin}: ccxt ${pct(fr.fundingRate, 5)} (прогноз ${pct(fr.nextFundingRate, 5)}); сире fundingRate=${info.fundingRate}, fundingRatePrediction=${info.fundingRatePrediction}, markPrice=${info.markPrice}` +
          `\n      виплати з історії: ${hist}\n      інші біржі: ${others.join(', ')}`);
      }
    } catch (e) {
      out(`❌ ${e.message.slice(0, 200)}`);
    }
  }

  // Фактичні комісії акаунтів (як у бота): інакше сканер нижче рахує чистий профіт за стандартними
  await Promise.all(Object.values(ex).filter((e) => e.hasKeys && e.loadAccountFees).map((e) => e.loadAccountFees().catch(() => {})));

  // 5) Стакани
  out('\n== 5. Стакани (BTC) ==');
  for (const e of Object.values(ex)) {
    try {
      const [ob, ms] = await timed(() => e.fetchOrderBook('BTC/USDT:USDT'));
      const bid = ob.bids[0] && ob.bids[0][0];
      const ask = ob.asks[0] && ob.asks[0][0];
      out(`${e.id}: bid ${bid} / ask ${ask}, спред ${bid && ask ? pct((ask - bid) / bid, 3) : '—'}, рівнів ${ob.bids.length}/${ob.asks.length}, ${ms} мс` +
        `, крок ${e.amountStep('BTC/USDT:USDT')} BTC, тейкер ${pct(e.takerFee('BTC/USDT:USDT'), 3)}`);
    } catch (err) {
      out(`${e.id}: ❌ ${err.message.slice(0, 200)}`);
    }
  }

  // 6) Сканер
  out('\n== 6. Сканер можливостей (за поточними порогами і фільтрами бота) ==');
  await Promise.all(Object.values(ex).map((e) => e.loadTickers().catch(() => {})));
  // ті самі фільтри, що й у бота: ризики ринку (лістинг/делістинг/статус), обсяг, однаковість монети за ціною
  const coins = new CoinRegistry(cfg, null);
  const marketProblem = (coin, id) => {
    const sym = `${coin}/USDT:USDT`;
    const risk = ex[id].marketRisk(sym, cfg);
    if (risk) return `${id}: ${risk}`;
    const v = ex[id].tickers[sym] && ex[id].tickers[sym].volumeUsdt;
    if (cfg.minVolumeUsdt > 0 && v !== undefined && v < cfg.minVolumeUsdt) return `${id}: обсяг за 24 год ${Math.round(v).toLocaleString('uk-UA')} USDT < ${cfg.minVolumeUsdt.toLocaleString('uk-UA')}`;
    return undefined;
  };
  const coinCheck = (coin, a, b, ma, mb) => {
    const p = marketProblem(coin, a) || marketProblem(coin, b);
    return p ? { ok: false, reason: p } : coins.check(coin, a, b, ma, mb);
  };
  const fee = (id, s) => ex[id].takerFee(s);
  const untrusted = untrustedRates(Object.keys(rates), cfg.trustRates);
  const tradeRates = { ...rates };
  for (const id of untrusted) delete tradeRates[id];
  if (untrusted.length) out(`Не беруть участі (масштаб ставок не підтверджено): ${untrusted.join(', ')} — увімкнути: TRUST_RATES=${untrusted.join(',')}`);
  const raw = planWindows(tradeRates, cfg, fee);
  const wins = planWindows(tradeRates, cfg, fee, Date.now(), coinCheck);
  out(`Вікон за порогами (фандінг ≥ ${pct(cfg.minFunding, 2)}, чистий ≥ ${pct(cfg.minProfit, 2)}): ${raw.length}; з них проходять фільтри бота: ${wins.length}`);
  for (const w of raw.slice(0, 15)) {
    const coin = w.symbol.split('/')[0];
    const r = rates[w.shortEx][w.symbol];
    const l = rates[w.longEx][w.symbol];
    const chk = coinCheck(coin, w.shortEx, w.longEx, r && r.mark, l && l.mark);
    out(`   ${chk.ok ? '✅' : '⛔'} ${coin}: SHORT ${w.shortEx} ${pct(w.shortRate, 3)}/${w.shortIntervalH}h, LONG ${w.longEx} ${pct(w.longRate, 3)}/${w.longIntervalH}h, ` +
      `виплати ${new Date(w.startTs).toISOString().slice(11, 16)}${w.endTs !== w.startTs ? `–${new Date(w.endTs).toISOString().slice(11, 16)}` : ''} UTC — фандінг ${pct(w.funding, 3)}, чистий ${pct(w.net, 3)}${w.estimated ? ' (частково оцінка)' : ''}` +
      `${chk.ok ? '' : `\n        не торгується: ${chk.reason}`}`);
  }

  // 7) Самоперевірка (лише з --selftest)
  const keyed = Object.values(ex).filter((e) => e.hasKeys);
  out('\n== 7. Самоперевірка бірж з ключами ==');
  if (!flag('selftest')) out('пропущено (запустіть з --selftest; ставить лише лімітний ордер, що не виконається)');
  else if (!keyed.length) out('немає бірж з ключами');
  else {
    for (const e of keyed) {
      const r = await e.runSelfTest().catch((err) => ({ ok: false, checks: [{ name: 'самоперевірка', ok: false, info: err.message }] }));
      out(`${r.ok ? '✅' : '⛔'} ${e.title}`);
      for (const c of r.checks) out(`   ${c.ok ? '✓' : c.critical === false ? '⚠' : '✗'} ${c.name}: ${c.info}`);
    }
  }

  // 8) Перевірка на історії (лише з --backtest N)
  const days = arg('backtest', 0);
  if (days > 0) {
    out(`\n== 8. Перевірка на історії за ${days} дн ==`);
    try {
      const btEx = { ...ex };
      for (const id of untrustedRates(Object.keys(btEx), cfg.trustRates)) delete btEx[id];
      const r = await runBacktest({ exchanges: btEx, cfg, days, maxCoins: arg('coins', 40), rates, onProgress: (d, n) => process.stdout.write(`\r   ${d}/${n} монет`) });
      process.stdout.write('\n');
      out(r.text);
    } catch (err) {
      out(`❌ ${err.message}`);
    }
  }
})()
  .catch((e) => out(`\n❌ Аварійна помилка: ${e.stack || e.message}`))
  .finally(() => {
    const file = path.join(__dirname, '..', 'data', 'check-report.txt');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${lines.join('\n')}\n`);
    console.log(`\nЗвіт збережено: ${file}`);
  });
