import type { Address, Hex } from 'viem';
import type { ChainWallet } from './wallet.js';

const API = 'https://aggregator-api.kyberswap.com';

export interface DexQuote {
  amountIn: bigint;
  amountOut: bigint;
  gasUsd: number;
  routeSummary: unknown;
  router: Address;
}

/**
 * KyberSwap aggregator: best route across all DEXes on the chain
 * (Uniswap, Pancake, Curve, Camelot, ...). Free, no API key.
 */
export class Kyber {
  constructor(private clientId: string) {}

  async quote(slug: string, tokenIn: Address, tokenOut: Address, amountIn: bigint): Promise<DexQuote> {
    const url = `${API}/${slug}/api/v1/routes?tokenIn=${tokenIn}&tokenOut=${tokenOut}&amountIn=${amountIn}&gasInclude=true`;
    const r = await this.req(url);
    const s = r.data.routeSummary;
    return { amountIn, amountOut: BigInt(s.amountOut), gasUsd: Number(s.gasUsd ?? 0), routeSummary: s, router: r.data.routerAddress };
  }

  /** Re-quote + build calldata + send. Returns tx hash (persist it before waiting). */
  async swap(w: ChainWallet, tokenIn: Address, tokenOut: Address, amountIn: bigint, slippageBps: number, minOutAbs: bigint, beforeSend?: () => void): Promise<{ hash: Hex; quotedOut: bigint }> {
    const q = await this.quote(w.cfg.kyberSlug, tokenIn, tokenOut, amountIn);
    if (q.amountOut < minOutAbs) throw new Error(`quote ${q.amountOut} below required ${minOutAbs}`);
    const b = await this.req(`${API}/${w.cfg.kyberSlug}/api/v1/route/build`, {
      routeSummary: q.routeSummary,
      sender: w.address,
      recipient: w.address,
      slippageTolerance: slippageBps,
      deadline: Math.floor(Date.now() / 1000) + 300,
    });
    const router = b.data.routerAddress as Address;
    await w.ensureApproval(tokenIn, router, amountIn);
    const gas = b.data.gas ? (BigInt(b.data.gas) * 13n) / 10n : undefined;
    beforeSend?.();
    const hash = await w.sendRaw(router, b.data.data as Hex, gas);
    return { hash, quotedOut: q.amountOut };
  }

  private async req(url: string, body?: unknown): Promise<any> {
    const res = await fetch(url, {
      method: body ? 'POST' : 'GET',
      headers: { 'x-client-id': this.clientId, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(8000),
    });
    const j: any = await res.json().catch(() => ({}));
    if (!res.ok || j.code !== 0) throw new Error(`kyber ${res.status}: ${j.message ?? 'error'}`);
    return j;
  }
}
