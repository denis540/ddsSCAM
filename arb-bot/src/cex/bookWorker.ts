/**
 * Market-data worker thread: one per exchange.
 * Owns the exchange's public WebSocket connections, parses/merges order-book
 * deltas (the CPU-heavy part with hundreds of symbols) and posts compact
 * top-N snapshots to the main thread, coalesced to at most one per symbol per
 * `throttleMs`. The main thread's event loop stays free for decisions and orders.
 */
import { parentPort, workerData } from 'node:worker_threads';
import ccxt from 'ccxt';

interface Init {
  exchangeId: string;
  symbols: { asset: string; symbol: string }[];
  depth: number;
  throttleMs: number;
}

const { exchangeId, symbols, depth, throttleMs } = workerData as Init;
const ex = new (ccxt as any).pro[exchangeId]({ enableRateLimit: true, options: { defaultType: 'spot' } });
const pending = new Map<string, { bids: number[][]; asks: number[][]; ts: number }>();
let stopped = false;

parentPort!.on('message', (m) => {
  if (m === 'stop') {
    stopped = true;
    ex.close().catch(() => {}).finally(() => process.exit(0));
  }
});

// Coalesce: only the newest snapshot per symbol is sent each tick.
setInterval(() => {
  if (!pending.size) return;
  const batch = [...pending.entries()].map(([asset, b]) => ({ asset, ...b }));
  pending.clear();
  parentPort!.postMessage({ type: 'books', batch });
}, throttleMs);

async function stream(asset: string, symbol: string) {
  let backoff = 1000;
  while (!stopped) {
    try {
      const ob = await ex.watchOrderBook(symbol, depth);
      pending.set(asset, { bids: ob.bids.slice(0, depth), asks: ob.asks.slice(0, depth), ts: Date.now() });
      backoff = 1000;
    } catch (e) {
      if (stopped) return;
      parentPort!.postMessage({ type: 'error', asset, err: e instanceof Error ? e.message : String(e) });
      await new Promise((r) => setTimeout(r, backoff));
      backoff = Math.min(backoff * 2, 30_000);
    }
  }
}

(async () => {
  await ex.loadMarkets();
  for (const s of symbols) void stream(s.asset, s.symbol);
  parentPort!.postMessage({ type: 'ready', count: symbols.length });
})().catch((e) => {
  parentPort!.postMessage({ type: 'fatal', err: e instanceof Error ? e.message : String(e) });
  process.exit(1);
});
