import { loadConfig } from './config.js';
import { Venue } from './cex/venue.js';
import { ChainWallet } from './chain/wallet.js';
import { DexRouter } from './chain/aggregators.js';
import { Journal, Blacklist } from './core/journal.js';
import { CycleStore } from './core/store.js';
import { CycleRunner } from './core/cycles.js';
import { Scanner } from './core/scanner.js';
import { RiskManager } from './core/risk.js';
import { Notifier } from './core/notifier.js';
import { log, errMsg } from './core/logger.js';
import { sleep } from './core/utils.js';

async function main() {
  const cfg = loadConfig();
  log.info('starting', { dryRun: cfg.dryRun, exchanges: cfg.exchanges, assets: cfg.assets.map((a) => `${a.symbol}@${a.chain}`) });
  const notify = new Notifier(cfg.telegram.token, cfg.telegram.chatId);

  // Chains
  const account = ChainWallet.account(cfg.privateKey);
  const wallets = new Map<string, ChainWallet>();
  for (const ch of Object.values(cfg.chains)) {
    const w = new ChainWallet(ch, account);
    const id = await w.pub.getChainId();
    if (id !== ch.chainId) throw new Error(`RPC for ${ch.name} returned chainId ${id}, expected ${ch.chainId}`);
    wallets.set(ch.name, w);
  }
  if (account) log.info('wallet', { address: account.address });

  // Exchanges (a failing exchange is skipped, not fatal)
  const venues = new Map<string, Venue>();
  await Promise.all(
    cfg.exchanges.map(async (id) => {
      try {
        const v = new Venue(id, cfg.quote);
        await v.init();
        if (!cfg.dryRun && !v.hasKeys) throw new Error('no API keys');
        await v.refreshNetworks(cfg.assets, cfg.chains);
        venues.set(id, v);
        const markets = cfg.assets.filter((a) => v.hasMarket(a.symbol));
        markets.forEach((a) => v.watchBook(a.symbol));
        log.info('exchange ready', { id, markets: markets.map((a) => a.symbol), networks: Object.fromEntries(v.net) });
      } catch (e) {
        log.error('exchange disabled', { id, err: errMsg(e) });
      }
    }),
  );
  if (!venues.size) throw new Error('no exchanges available');

  const risk = new RiskManager(cfg.risk);
  const store = new CycleStore();
  const dex = new DexRouter(cfg.strategy.aggregators, cfg.kyberClientId, cfg.odosApiKey, cfg.strategy.dexSlippageBps);
  const journal = new Journal();
  const blacklist = new Blacklist();
  const runner = new CycleRunner(cfg, store, venues, wallets, dex, risk, notify, journal, blacklist);
  const scanner = new Scanner(cfg, venues, wallets, dex, runner, risk, journal, blacklist);

  // ── Telegram remote control
  const fmtPnl = (since: number) =>
    Object.entries(journal.summary(since)).map(([m, x]) => `${m}: ${x.n} cycles, pnl ${x.pnl.toFixed(2)}$, win ${x.n ? ((x.wins / x.n) * 100).toFixed(0) : 0}%`).join('\n') || 'no cycles yet';
  notify.command('/help', () => '/status /cycles /opps /pnl /pause /resume');
  notify.command('/status', () =>
    [`mode: ${cfg.dryRun ? 'DRY RUN (paper)' : 'LIVE'}`, `trading: ${risk.halted ? `HALTED (${risk.haltReason})` : 'on'}`,
      `exchanges: ${[...venues.keys()].join(', ')}`, `assets: ${cfg.assets.length}`, `active cycles: ${store.active().length}, attention: ${store.attention().length}`,
      `today pnl: ${risk.dailyPnl.toFixed(2)}$`].join('\n'));
  notify.command('/cycles', () =>
    [...store.active(), ...store.attention()].map((c) => `${c.id} ${c.direction} ${c.step}${c.error ? ` (${c.error})` : ''}`).join('\n') || 'no active cycles');
  notify.command('/opps', () =>
    scanner.lastCandidates.slice(0, 10).map((c) => `${c.asset.symbol}@${c.exchange} ${c.direction} ${c.sizeQuote}$ → ${c.profitUsd.toFixed(2)}$ (${c.profitBps.toFixed(0)}bps)`).join('\n') || 'none right now');
  notify.command('/pnl', () => `24h:\n${fmtPnl(Date.now() - 864e5)}\n7d:\n${fmtPnl(Date.now() - 7 * 864e5)}`);
  notify.command('/pause', () => (risk.halt('paused via Telegram'), 'paused: no new cycles (active ones finish)'));
  notify.command('/resume', () => (risk.resume(), 'resumed'));
  notify.startPolling();

  runner.resumeAll(); // continue cycles interrupted by a restart
  notify.send(`🤖 arb bot started (${cfg.dryRun ? 'DRY RUN' : 'LIVE'}), exchanges: ${[...venues.keys()].join(', ')}`);

  const netTimer = setInterval(() => {
    for (const v of venues.values()) v.refreshNetworks(cfg.assets, cfg.chains).catch((e) => log.warn('network refresh failed', { ex: v.id, err: errMsg(e) }));
  }, 3 * 60_000);

  let stopping = false;
  const shutdown = async (sig: string) => {
    if (stopping) return;
    stopping = true;
    log.info('shutting down — active cycles resume on next start', { sig });
    risk.halt(`shutdown (${sig})`);
    clearInterval(netTimer);
    notify.stop();
    await Promise.all([...venues.values()].map((v) => v.close()));
    notify.send('🛑 arb bot stopped');
    setTimeout(() => process.exit(0), 300);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('unhandledRejection', (e) => log.error('unhandledRejection', { err: errMsg(e) }));

  await sleep(3000); // let order books fill
  while (!stopping) {
    const t0 = Date.now();
    await scanner.scan().catch((e) => log.error('scan failed', { err: errMsg(e) }));
    await sleep(Math.max(0, cfg.strategy.scanIntervalMs - (Date.now() - t0)));
  }
}

main().catch((e) => {
  log.error('fatal', { err: errMsg(e) });
  process.exit(1);
});
