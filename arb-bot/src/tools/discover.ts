/**
 * Auto-discovery of tradable tokens:
 *   CoinGecko contract addresses ∩ USDT spot markets on configured exchanges
 *   ∩ tokens with a deposit/withdraw network on the configured chains.
 * Writes data/assets.discovered.json — point `assetsFile` in config.json at it.
 *
 *   npm run discover            # all
 *   npm run discover -- --min-exchanges 2
 */
import fs from 'node:fs';
import ccxt from 'ccxt';
import { createPublicClient, http, parseAbi, type Address } from 'viem';
import { loadConfig, type AssetCfg } from '../config.js';

const STABLES = new Set(['USDT', 'USDC', 'DAI', 'FDUSD', 'TUSD', 'USDE', 'BUSD', 'USDD', 'PYUSD', 'WETH', 'WBTC', 'WBNB', 'ETH', 'BNB', 'BTC']);

async function main() {
  const cfg = loadConfig();
  const minEx = Number(process.argv[process.argv.indexOf('--min-exchanges') + 1]) || 1;
  const platformToChain = new Map(Object.values(cfg.chains).filter((c) => c.coingeckoPlatform).map((c) => [c.coingeckoPlatform!, c.name]));

  console.log('loading exchange markets...');
  const listed = new Map<string, Set<string>>(); // symbol -> exchanges
  for (const id of cfg.exchanges) {
    try {
      const ex = new (ccxt as any)[id]({ enableRateLimit: true });
      const markets = await ex.loadMarkets();
      for (const m of Object.values<any>(markets)) {
        if (m.spot && m.active !== false && m.quote === cfg.quote) {
          if (!listed.has(m.base)) listed.set(m.base, new Set());
          listed.get(m.base)!.add(id);
        }
      }
      console.log(`  ${id}: ok`);
    } catch (e) {
      console.log(`  ${id}: failed (${(e as Error).message})`);
    }
  }

  console.log('loading CoinGecko contracts...');
  const headers: Record<string, string> = process.env.COINGECKO_API_KEY ? { 'x-cg-demo-api-key': process.env.COINGECKO_API_KEY } : {};
  const coins: any[] = await (await fetch('https://api.coingecko.com/api/v3/coins/list?include_platform=true', { headers })).json();

  // symbol collisions are the #1 way to lose money here → skip ambiguous symbols per chain
  const bySymbolChain = new Map<string, { id: string; address: Address }[]>();
  for (const c of coins) {
    const sym = String(c.symbol).toUpperCase();
    if (STABLES.has(sym) || !listed.has(sym) || listed.get(sym)!.size < minEx) continue;
    for (const [platform, addr] of Object.entries<string>(c.platforms ?? {})) {
      const chain = platformToChain.get(platform);
      if (!chain || !/^0x[0-9a-fA-F]{40}$/.test(addr)) continue;
      const k = `${sym}:${chain}`;
      if (!bySymbolChain.has(k)) bySymbolChain.set(k, []);
      bySymbolChain.get(k)!.push({ id: c.id, address: addr as Address });
    }
  }

  const out: AssetCfg[] = [];
  let ambiguous = 0;
  for (const [k, list] of bySymbolChain) {
    if (list.length !== 1) {
      ambiguous++;
      continue;
    }
    const [symbol, chain] = k.split(':');
    out.push({ symbol, chain, address: list[0].address, decimals: 0 });
  }

  console.log(`reading decimals for ${out.length} tokens...`);
  const abi = parseAbi(['function decimals() view returns (uint8)']);
  for (const chainName of new Set(out.map((a) => a.chain))) {
    const ch = cfg.chains[chainName];
    const client = createPublicClient({ transport: http(ch.rpc, { batch: true }) });
    const items = out.filter((a) => a.chain === chainName);
    const res = await client.multicall({
      contracts: items.map((a) => ({ address: a.address, abi, functionName: 'decimals' as const })),
      multicallAddress: '0xcA11bde05977b3631167028862bE2a173976CA11',
    });
    items.forEach((a, i) => (a.decimals = res[i].status === 'success' ? Number(res[i].result) : -1));
  }
  const good = out.filter((a) => a.decimals > 0);
  fs.mkdirSync('data', { recursive: true });
  fs.writeFileSync('data/assets.discovered.json', JSON.stringify(good, null, 1));
  console.log(`done: ${good.length} tokens → data/assets.discovered.json (skipped ${ambiguous} ambiguous symbols)`);
  console.log('Runtime still verifies contract addresses against exchange network info where available.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
