import 'dotenv/config';
import type { Address, Hex } from 'viem';

function str(name: string, def?: string): string {
  const v = process.env[name] ?? def;
  if (v === undefined || v === '') throw new Error(`Missing env ${name}`);
  return v;
}
function opt(name: string): string | undefined {
  const v = process.env[name];
  return v === undefined || v === '' ? undefined : v;
}
function num(name: string, def?: number): number {
  const raw = process.env[name];
  const v = raw === undefined || raw === '' ? def : Number(raw);
  if (v === undefined || !Number.isFinite(v)) throw new Error(`Bad number env ${name}`);
  return v;
}
function bool(name: string, def: boolean): boolean {
  const v = process.env[name];
  if (v === undefined || v === '') return def;
  return v.toLowerCase() === 'true' || v === '1';
}

export function loadConfig() {
  const dryRun = bool('DRY_RUN', true);
  const cfg = {
    dryRun,
    baseAsset: str('BASE_ASSET', 'ETH'),
    quoteAsset: str('QUOTE_ASSET', 'USDC'),
    cexSymbol: str('CEX_SYMBOL', 'ETHUSDC'),

    binance: {
      apiKey: dryRun ? opt('BINANCE_API_KEY') : str('BINANCE_API_KEY'),
      apiSecret: dryRun ? opt('BINANCE_API_SECRET') : str('BINANCE_API_SECRET'),
      restUrl: str('BINANCE_REST_URL', 'https://api.binance.com'),
      wsUrl: str('BINANCE_WS_URL', 'wss://stream.binance.com:9443/ws'),
      takerFee: num('CEX_TAKER_FEE', 0.001),
    },

    chain: {
      id: num('CHAIN_ID', 42161),
      rpcHttp: str('RPC_HTTP_URL'),
      rpcWs: opt('RPC_WS_URL'),
      privateKey: (dryRun ? opt('PRIVATE_KEY') : str('PRIVATE_KEY')) as Hex | undefined,
      quoter: str('UNI_QUOTER_V2', '0x61fFE014bA17989E743c5F6cB21bF9697530B21e') as Address,
      router: str('UNI_SWAP_ROUTER02', '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45') as Address,
      poolFee: num('UNI_POOL_FEE', 500),
      baseToken: str('BASE_TOKEN') as Address,
      baseDecimals: num('BASE_DECIMALS', 18),
      quoteToken: str('QUOTE_TOKEN') as Address,
      quoteDecimals: num('QUOTE_DECIMALS', 6),
      swapGasUnits: num('SWAP_GAS_UNITS', 200_000),
      autoApprove: bool('AUTO_APPROVE', true),
    },

    strategy: {
      minProfitUsd: num('MIN_PROFIT_USD', 2),
      minProfitBps: num('MIN_PROFIT_BPS', 8),
      minTradeQuote: num('MIN_TRADE_QUOTE', 200),
      maxTradeQuote: num('MAX_TRADE_QUOTE', 5000),
      sizeSteps: Math.max(1, num('SIZE_STEPS', 6)),
      dexSlippageBps: num('DEX_SLIPPAGE_BPS', 10),
      txDeadlineSec: num('TX_DEADLINE_SEC', 30),
      reevalOnCexMoveBps: num('REEVAL_ON_CEX_MOVE_BPS', 2),
      cexStaleMs: num('CEX_STALE_MS', 1500),
    },

    risk: {
      maxDailyLossUsd: num('MAX_DAILY_LOSS_USD', 50),
      maxConsecutiveFailures: num('MAX_CONSECUTIVE_FAILURES', 3),
      minBaseReserve: num('MIN_BASE_RESERVE', 0.01),
      minQuoteReserve: num('MIN_QUOTE_RESERVE', 20),
      tradeCooldownMs: num('TRADE_COOLDOWN_MS', 1500),
    },

    telegram: {
      token: opt('TELEGRAM_BOT_TOKEN'),
      chatId: opt('TELEGRAM_CHAT_ID'),
    },
  };
  if (cfg.strategy.minTradeQuote > cfg.strategy.maxTradeQuote) {
    throw new Error('MIN_TRADE_QUOTE > MAX_TRADE_QUOTE');
  }
  return cfg;
}

export type Config = ReturnType<typeof loadConfig>;
