import type { Address, Hex } from 'viem';
import type { ChainCfg } from '../config.js';
import type { ChainWallet } from './wallet.js';
import { log, errMsg } from '../core/logger.js';

/** Placeholder sender for quotes when no wallet is configured (dry run). */
const DUMMY: Address = '0x000000000000000000000000000000000000dEaD';

export interface Quote {
  source: string;
  amountIn: bigint;
  amountOut: bigint;
  gasUsd: number;
  /** Build executable calldata for this exact quote. */
  build(sender: Address, slippageBps: number): Promise<{ to: Address; data: Hex; gas?: bigint }>;
}

interface Aggregator {
  name: string;
  quote(chain: ChainCfg, tokenIn: Address, tokenOut: Address, amountIn: bigint, user?: Address): Promise<Quote>;
}

async function req(url: string, headers: Record<string, string>, body?: unknown): Promise<any> {
  const res = await fetch(url, {
    method: body ? 'POST' : 'GET',
    headers: { ...headers, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(8000),
  });
  const j: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${new URL(url).host} ${res.status}: ${j.message ?? j.detail ?? 'error'}`);
  return j;
}

/** KyberSwap aggregator — free, no key. */
class KyberAgg implements Aggregator {
  name = 'kyber';
  constructor(private clientId: string) {}
  async quote(chain: ChainCfg, tokenIn: Address, tokenOut: Address, amountIn: bigint): Promise<Quote> {
    const base = `https://aggregator-api.kyberswap.com/${chain.kyberSlug}/api/v1`;
    const h = { 'x-client-id': this.clientId };
    const r = await req(`${base}/routes?tokenIn=${tokenIn}&tokenOut=${tokenOut}&amountIn=${amountIn}&gasInclude=true`, h);
    if (r.code !== 0) throw new Error(`kyber: ${r.message}`);
    const s = r.data.routeSummary;
    return {
      source: this.name,
      amountIn,
      amountOut: BigInt(s.amountOut),
      gasUsd: Number(s.gasUsd ?? 0),
      build: async (sender, slippageBps) => {
        const b = await req(`${base}/route/build`, h, {
          routeSummary: s, sender, recipient: sender, slippageTolerance: slippageBps, deadline: Math.floor(Date.now() / 1000) + 300,
        });
        if (b.code !== 0) throw new Error(`kyber build: ${b.message}`);
        return { to: b.data.routerAddress, data: b.data.data, gas: b.data.gas ? BigInt(b.data.gas) : undefined };
      },
    };
  }
}

/** Odos smart order router — public API (optional ODOS_API_KEY). */
class OdosAgg implements Aggregator {
  name = 'odos';
  constructor(private apiKey: string | undefined, private slippagePct: number) {}
  async quote(chain: ChainCfg, tokenIn: Address, tokenOut: Address, amountIn: bigint, user?: Address): Promise<Quote> {
    const h: Record<string, string> = this.apiKey ? { 'x-api-key': this.apiKey } : {};
    const userAddr = user ?? DUMMY;
    const q = await req('https://api.odos.xyz/sor/quote/v2', h, {
      chainId: chain.chainId,
      inputTokens: [{ tokenAddress: tokenIn, amount: amountIn.toString() }],
      outputTokens: [{ tokenAddress: tokenOut, proportion: 1 }],
      userAddr,
      slippageLimitPercent: this.slippagePct,
      compact: true,
    });
    return {
      source: this.name,
      amountIn,
      amountOut: BigInt(q.outAmounts[0]),
      gasUsd: Number(q.gasEstimateValue ?? 0),
      build: async (sender) => {
        // Odos binds slippage at quote time and pathId to userAddr → re-quote for the real sender if needed
        let pathId = q.pathId;
        if (sender.toLowerCase() !== userAddr.toLowerCase()) pathId = ((await this.quote(chain, tokenIn, tokenOut, amountIn, sender)) as any).pathId;
        const a = await req('https://api.odos.xyz/sor/assemble', h, { userAddr: sender, pathId, simulate: false });
        const t = a.transaction;
        return { to: t.to, data: t.data, gas: t.gas ? BigInt(t.gas) : undefined };
      },
      pathId: q.pathId,
    } as Quote & { pathId: string };
  }
}

/** Queries all enabled aggregators in parallel and returns the best net-of-gas quote. */
export class DexRouter {
  private aggs: Aggregator[] = [];
  constructor(names: string[], kyberClientId: string, odosKey: string | undefined, slippageBps: number) {
    for (const n of names) {
      if (n === 'kyber') this.aggs.push(new KyberAgg(kyberClientId));
      else if (n === 'odos') this.aggs.push(new OdosAgg(odosKey, slippageBps / 100));
      else throw new Error(`unknown aggregator ${n}`);
    }
  }

  /** Best quote; `fast` uses only the first aggregator (cheap probing of many tokens). */
  async quote(chain: ChainCfg, tokenIn: Address, tokenOut: Address, amountIn: bigint, opts: { fast?: boolean; user?: Address; usdPerOutUnit?: number } = {}): Promise<Quote> {
    const list = opts.fast ? this.aggs.slice(0, 1) : this.aggs;
    const res = await Promise.allSettled(list.map((a) => a.quote(chain, tokenIn, tokenOut, amountIn, opts.user)));
    const ok = res.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []));
    if (!ok.length) throw new Error(`no DEX quote: ${res.map((r) => (r.status === 'rejected' ? errMsg(r.reason) : '')).join('; ')}`);
    const k = opts.usdPerOutUnit ?? 0; // compare net of gas when we know the USD value of output units
    return ok.reduce((b, q) => (Number(q.amountOut) * k - q.gasUsd > Number(b.amountOut) * k - b.gasUsd || (!k && q.amountOut > b.amountOut) ? q : b));
  }

  /**
   * Fresh best quote → build → approve → send. `beforeSend` marks the persisted
   * cycle right before broadcast so a crash can never cause a duplicate swap.
   */
  async swap(w: ChainWallet, tokenIn: Address, tokenOut: Address, amountIn: bigint, slippageBps: number, minOut: bigint, beforeSend?: () => void) {
    const q = await this.quote(w.cfg, tokenIn, tokenOut, amountIn, { user: w.address });
    if (q.amountOut < minOut) throw new Error(`best quote ${q.amountOut} below required ${minOut}`);
    const tx = await q.build(w.address, slippageBps);
    await w.ensureApproval(tokenIn, tx.to, amountIn);
    beforeSend?.();
    const hash = await w.sendRaw(tx.to, tx.data, tx.gas ? (tx.gas * 13n) / 10n : undefined);
    log.info('dex swap sent', { via: q.source, hash, quotedOut: q.amountOut });
    return { hash, quotedOut: q.amountOut, source: q.source };
  }
}
