import 'dotenv/config';
import fs from 'node:fs';
import type { FeeMode } from './cex/venue.js';
import type { Address, Hex } from 'viem';

export interface ChainCfg {
  name: string;
  chainId: number;
  rpc: string;
  kyberSlug: string;
  networkCodes: string[];
  stable: { symbol: string; address: Address; decimals: number };
  transferGasUsd: number;
  minNativeBalance: number;
  coingeckoPlatform?: string;
}

export interface AssetCfg {
  symbol: string;
  chain: string;
  address: Address;
  decimals: number;
}

export interface Config {
  dryRun: boolean;
  quote: string;
  exchanges: string[];
  withdrawFeeMode: Record<string, FeeMode>;
  chains: Record<string, ChainCfg>;
  assets: AssetCfg[];
  strategy: {
    scanIntervalMs: number;
    sizing: {
      /** Max price slippage per leg (CEX order book and DEX price impact), bps. 5 = 0.05% */
      maxSlippageBps: number;
      minTradeQuote: number;
      /** Fraction of a funding source's equity one cycle may use (0.5 = 50%). */
      capitalFraction: number;
      ladderPoints: number;
      /** Virtual balance per source in dry run. */
      paperCapitalQuote: number;
    };
    minProfitUsd: number;
    minProfitBps: number;
    riskBufferBps: number;
    confirmScans: number;
    dexSlippageBps: number;
    autoReturn: boolean;
    secondLegMaxLossBps: number;
    secondLegMaxWaitMin: number;
    aggregators: string[];
    /** Cheap 1-aggregator probe; full ladder only if edge ≥ this. */
    probeEdgeBps: number;
    maxAssetsParallel: number;
    /** Order books parsed in one worker thread per exchange (frees the main loop). */
    marketDataWorkers: boolean;
    /** Max frequency of book snapshots from workers, ms. */
    bookThrottleMs: number;
    /** Dry run: simulate the second leg after this many minutes to get realistic PnL. */
    paperTransferMin: number;
    hedge: {
      enabled: boolean;
      /** true = skip opportunities that cannot be hedged */
      required: boolean;
      /** Where to short perps if the trading exchange has no perp market (in priority order). */
      venues: string[];
      leverage: number;
      /** Skip a hedge venue if shorts PAY more than this per 8h (bps). 10 = 0.1%/8h */
      maxNegFundingBps8h: number;
    };
  };
  risk: {
    maxConcurrentCycles: number;
    maxDailyLossUsd: number;
    maxConsecutiveFailures: number;
    transferTimeoutMin: number;
    orderBookStaleMs: number;
    /** No new cycles while this many cycles wait for manual action (/resolve). */
    maxAttentionCycles: number;
    equity: {
      checkEveryMin: number;
      /** Alert if equity is below expected by more than this % … */
      alertDropPct: number;
      /** … and stop new cycles if below by more than this %. */
      haltDropPct: number;
    };
  };
  privateKey?: Hex;
  telegram: { token?: string; chatId?: string };
  kyberClientId: string;
  odosApiKey?: string;
}

const env = (k: string) => (process.env[k] ? process.env[k] : undefined);

export function loadConfig(path = process.env.CONFIG ?? 'config.json'): Config {
  if (!fs.existsSync(path)) throw new Error(`${path} not found — copy config.example.json to config.json`);
  const raw = JSON.parse(fs.readFileSync(path, 'utf8'));
  const chains: Record<string, ChainCfg> = {};
  for (const [name, c] of Object.entries<any>(raw.chains)) {
    const rpc = env(c.rpcEnv);
    if (!rpc) throw new Error(`RPC env ${c.rpcEnv} for chain ${name} is empty`);
    chains[name] = { ...c, name, rpc };
  }
  if (raw.assetsFile && fs.existsSync(raw.assetsFile)) {
    const extra = JSON.parse(fs.readFileSync(raw.assetsFile, 'utf8')) as AssetCfg[];
    const have = new Set((raw.assets ?? []).map((a: AssetCfg) => `${a.symbol}:${a.chain}`));
    raw.assets = [...(raw.assets ?? []), ...extra.filter((a) => !have.has(`${a.symbol}:${a.chain}`) && chains[a.chain])];
  }
  const st = raw.strategy;
  st.aggregators ??= ['kyber', 'odos'];
  st.sizing = { maxSlippageBps: 5, minTradeQuote: 20, capitalFraction: 0.5, ladderPoints: 7, paperCapitalQuote: 1000, ...(st.sizing ?? {}) };
  if (!(st.sizing.capitalFraction > 0 && st.sizing.capitalFraction <= 1)) throw new Error('sizing.capitalFraction must be in (0, 1]');
  st.probeEdgeBps ??= Math.max(0, st.minProfitBps / 2);
  st.maxAssetsParallel ??= 6;
  st.marketDataWorkers ??= true;
  st.bookThrottleMs ??= 50;
  st.paperTransferMin ??= 10;
  st.hedge = { enabled: false, required: false, venues: [], leverage: 2, maxNegFundingBps8h: 10, ...(st.hedge ?? {}) };
  raw.withdrawFeeMode ??= {};
  raw.risk.maxAttentionCycles ??= 1;
  raw.risk.equity = { checkEveryMin: 10, alertDropPct: 1.5, haltDropPct: 4, ...(raw.risk.equity ?? {}) };
  for (const a of raw.assets as AssetCfg[]) {
    if (!chains[a.chain]) throw new Error(`asset ${a.symbol}: unknown chain ${a.chain}`);
  }
  const envDry = env('DRY_RUN');
  const cfg: Config = {
    ...raw,
    dryRun: envDry !== undefined ? envDry === 'true' : raw.dryRun !== false,
    chains,
    privateKey: readPrivateKey(),
    telegram: { token: env('TELEGRAM_BOT_TOKEN'), chatId: env('TELEGRAM_CHAT_ID') },
    kyberClientId: env('KYBER_CLIENT_ID') ?? 'arb-bot',
    odosApiKey: env('ODOS_API_KEY'),
  };
  if (!cfg.dryRun && !cfg.privateKey) throw new Error('PRIVATE_KEY required in live mode');
  return cfg;
}

/** API credentials for a ccxt exchange id from env: BINANCE_API_KEY, BINANCE_SECRET, OKX_PASSWORD ... */
export function exchangeCreds(id: string) {
  const p = id.toUpperCase();
  return { apiKey: env(`${p}_API_KEY`), secret: env(`${p}_SECRET`), password: env(`${p}_PASSWORD`) };
}

/** PRIVATE_KEY_FILE (file with chmod 600, outside the repo) is preferred over plain PRIVATE_KEY in .env. */
function readPrivateKey(): Hex | undefined {
  const f = env('PRIVATE_KEY_FILE');
  if (f) {
    const st = fs.statSync(f);
    if ((st.mode & 0o077) !== 0) throw new Error(`${f} is readable by other users — run: chmod 600 ${f}`);
    const k = fs.readFileSync(f, 'utf8').trim();
    return (k.startsWith('0x') ? k : `0x${k}`) as Hex;
  }
  return env('PRIVATE_KEY') as Hex | undefined;
}
