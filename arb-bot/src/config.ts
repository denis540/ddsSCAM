import 'dotenv/config';
import fs from 'node:fs';
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
  chains: Record<string, ChainCfg>;
  assets: AssetCfg[];
  strategy: {
    scanIntervalMs: number;
    tradeSizesQuote: number[];
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
    /** Dry run: simulate the second leg after this many minutes to get realistic PnL. */
    paperTransferMin: number;
    hedge: {
      enabled: boolean;
      /** true = skip opportunities that cannot be hedged */
      required: boolean;
      /** Where to short perps if the trading exchange has no perp market (in priority order). */
      venues: string[];
      leverage: number;
    };
  };
  risk: {
    maxConcurrentCycles: number;
    maxDailyLossUsd: number;
    maxConsecutiveFailures: number;
    transferTimeoutMin: number;
    orderBookStaleMs: number;
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
  st.probeEdgeBps ??= Math.max(0, st.minProfitBps / 2);
  st.maxAssetsParallel ??= 6;
  st.paperTransferMin ??= 10;
  st.hedge = { enabled: false, required: false, venues: [], leverage: 2, ...(st.hedge ?? {}) };
  for (const a of raw.assets as AssetCfg[]) {
    if (!chains[a.chain]) throw new Error(`asset ${a.symbol}: unknown chain ${a.chain}`);
  }
  const envDry = env('DRY_RUN');
  const cfg: Config = {
    ...raw,
    dryRun: envDry !== undefined ? envDry === 'true' : raw.dryRun !== false,
    chains,
    privateKey: env('PRIVATE_KEY') as Hex | undefined,
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
