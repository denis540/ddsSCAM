import { loadConfig } from './config.js';
import { BinanceBookStream, BinanceRest } from './cex/binance.js';
import { UniswapV3 } from './dex/uniswapV3.js';
import { Engine } from './core/engine.js';
import { RiskManager } from './core/risk.js';
import { Notifier } from './core/notifier.js';
import { log, errMsg } from './core/logger.js';
import { retry, sleep } from './core/utils.js';

async function main() {
  const cfg = loadConfig();
  log.info('starting', { dryRun: cfg.dryRun, symbol: cfg.cexSymbol, chainId: cfg.chain.id });
  const notify = new Notifier(cfg.telegram.token, cfg.telegram.chatId);

  const rest = new BinanceRest(cfg.binance.restUrl, cfg.binance.apiKey, cfg.binance.apiSecret);
  await retry(() => rest.syncTime(), 5, 500);
  const filters = await retry(() => rest.getFilters(cfg.cexSymbol), 5, 500);
  log.info('symbol filters', { ...filters });

  const dex = new UniswapV3(cfg.chain);
  const chainId = await dex.pub.getChainId();
  if (chainId !== cfg.chain.id) throw new Error(`RPC chainId ${chainId} != CHAIN_ID ${cfg.chain.id}`);
  if (!cfg.dryRun) {
    await dex.ensureApproval(cfg.chain.baseToken);
    await dex.ensureApproval(cfg.chain.quoteToken);
  }

  const risk = new RiskManager(cfg.risk);
  let engine: Engine | undefined;
  const stream = new BinanceBookStream(cfg.binance.wsUrl, cfg.cexSymbol, (b) => engine?.onBook(b));
  engine = new Engine(cfg, rest, dex, risk, notify, filters, () => stream.book);
  await engine.refreshInventory();

  stream.start();
  const unwatch = dex.onBlock((bn) => engine!.onNewBlock(bn));

  const timers = [
    setInterval(() => engine!.refreshInventory().catch((e) => log.warn('inventory refresh failed', { err: errMsg(e) })), 30_000),
    setInterval(() => rest.syncTime().catch((e) => log.warn('time sync failed', { err: errMsg(e) })), 30 * 60_000),
  ];
  notify.send(`🤖 arb bot started (${cfg.dryRun ? 'DRY RUN' : 'LIVE'}) ${cfg.cexSymbol}`);

  let stopping = false;
  const shutdown = async (sig: string) => {
    if (stopping) return;
    stopping = true;
    log.info('shutting down', { sig });
    risk.halt(`shutdown (${sig})`); // no new trades
    unwatch();
    timers.forEach(clearInterval);
    // let an in-flight trade finish its hedge
    for (let i = 0; i < 100 && engine!.isBusy; i++) await sleep(100);
    stream.stop();
    notify.send('🛑 arb bot stopped');
    setTimeout(() => process.exit(0), 300);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('unhandledRejection', (e) => log.error('unhandledRejection', { err: errMsg(e) }));
}

main().catch((e) => {
  log.error('fatal', { err: errMsg(e) });
  process.exit(1);
});
