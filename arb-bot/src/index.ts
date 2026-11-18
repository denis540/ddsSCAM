import { loadConfig } from './config.js';
import { Venue } from './cex/venue.js';
import { ChainWallet } from './chain/wallet.js';
import { Kyber } from './chain/kyber.js';
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
  const kyber = new Kyber(cfg.kyberClientId);
  const runner = new CycleRunner(cfg, store, venues, wallets, kyber, risk, notify);
  const scanner = new Scanner(cfg, venues, wallets, kyber, runner, risk);

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
