import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  http,
  webSocket,
  maxUint256,
  parseEventLogs,
  defineChain,
  type Address,
  type PublicClient,
  type WalletClient,
  type Account,
  type Chain,
} from 'viem';
import { privateKeyToAccount, nonceManager } from 'viem/accounts';
import { arbitrum, mainnet, base, optimism, polygon } from 'viem/chains';
import { quoterV2Abi, swapRouter02Abi, erc20Abi } from './abis.js';
import { log, errMsg } from '../core/logger.js';
import type { Config } from '../config.js';

const KNOWN: Record<number, Chain> = { 1: mainnet, 10: optimism, 137: polygon, 8453: base, 42161: arbitrum };

export interface SwapResult {
  txHash: `0x${string}`;
  amountIn: bigint;
  amountOut: bigint;
  gasCostWei: bigint;
  latencyMs: number;
}

export class UniswapV3 {
  readonly pub: PublicClient;
  readonly wsPub?: PublicClient;
  private wallet?: WalletClient;
  readonly account?: Account;
  private chain: Chain;

  constructor(private cfg: Config['chain']) {
    this.chain =
      KNOWN[cfg.id] ??
      defineChain({ id: cfg.id, name: `chain-${cfg.id}`, nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [cfg.rpcHttp] } } });
    // batch: true => concurrent eth_calls (size ladder) go in one HTTP round-trip
    this.pub = createPublicClient({
      chain: this.chain,
      transport: http(cfg.rpcHttp, { batch: { wait: 0 }, timeout: 4000, retryCount: 1 }),
    }) as PublicClient;
    if (cfg.rpcWs) {
      this.wsPub = createPublicClient({ chain: this.chain, transport: webSocket(cfg.rpcWs, { reconnect: true, keepAlive: true }) }) as PublicClient;
    }
    if (cfg.privateKey) {
      this.account = privateKeyToAccount(cfg.privateKey, { nonceManager });
      this.wallet = createWalletClient({ account: this.account, chain: this.chain, transport: http(cfg.rpcHttp, { timeout: 8000 }) });
    }
  }

  get address(): Address | undefined {
    return this.account?.address;
  }

  /** Subscribe to new blocks (WS if available, else fast HTTP polling). */
  onBlock(cb: (blockNumber: bigint) => void): () => void {
    const client = this.wsPub ?? this.pub;
    return client.watchBlockNumber({
      onBlockNumber: cb,
      emitMissed: false,
      pollingInterval: 250,
      onError: (e) => log.warn('block watch error', { err: errMsg(e) }),
    });
  }

  async quoteExactIn(tokenIn: Address, tokenOut: Address, amountIn: bigint): Promise<bigint> {
    const { result } = await this.pub.simulateContract({
      address: this.cfg.quoter,
      abi: quoterV2Abi,
      functionName: 'quoteExactInputSingle',
      args: [{ tokenIn, tokenOut, amountIn, fee: this.cfg.poolFee, sqrtPriceLimitX96: 0n }],
    });
    return result[0];
  }

  async gasPrice(): Promise<bigint> {
    return this.pub.getGasPrice();
  }

  async balanceOf(token: Address): Promise<bigint> {
    if (!this.address) return 0n;
    return this.pub.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [this.address] });
  }

  async ensureApproval(token: Address): Promise<void> {
    if (!this.wallet || !this.account) return;
    const allowance = await this.pub.readContract({
      address: token,
      abi: erc20Abi,
      functionName: 'allowance',
      args: [this.account.address, this.cfg.router],
    });
    if (allowance > maxUint256 / 2n) return;
    if (!this.cfg.autoApprove) throw new Error(`Token ${token} not approved for router and AUTO_APPROVE=false`);
    log.info('approving token for router', { token });
    const hash = await this.wallet.writeContract({
      account: this.account,
      chain: this.chain,
      address: token,
      abi: erc20Abi,
      functionName: 'approve',
      args: [this.cfg.router, maxUint256],
    });
    const rc = await this.pub.waitForTransactionReceipt({ hash, timeout: 60_000 });
    if (rc.status !== 'success') throw new Error(`approve reverted: ${hash}`);
  }

  /**
   * Exact-input swap with on-chain slippage guard (amountOutMinimum) and a
   * deadline (router multicall). Either fills at >= minOut or reverts — so the
   * DEX leg can never execute at a worse price than we accepted.
   */
  async swapExactIn(tokenIn: Address, tokenOut: Address, amountIn: bigint, minOut: bigint, deadlineSec: number): Promise<SwapResult> {
    if (!this.wallet || !this.account) throw new Error('wallet not configured');
    const t0 = Date.now();
    const swapData = encodeFunctionData({
      abi: swapRouter02Abi,
      functionName: 'exactInputSingle',
      args: [{ tokenIn, tokenOut, fee: this.cfg.poolFee, recipient: this.account.address, amountIn, amountOutMinimum: minOut, sqrtPriceLimitX96: 0n }],
    });
    const deadline = BigInt(Math.floor(Date.now() / 1000) + deadlineSec);
    const data = encodeFunctionData({ abi: swapRouter02Abi, functionName: 'multicall', args: [deadline, [swapData]] });

    // Fixed gas limit skips an estimateGas round-trip (latency); the swap reverts
    // cheaply if conditions changed.
    const hash = await this.wallet.sendTransaction({
      account: this.account,
      chain: this.chain,
      to: this.cfg.router,
      data,
      gas: BigInt(Math.ceil(this.cfg.swapGasUnits * 1.5)),
    });
    const rc = await this.pub.waitForTransactionReceipt({ hash, timeout: 60_000, pollingInterval: 100 });
    const gasCostWei = rc.gasUsed * rc.effectiveGasPrice;
    if (rc.status !== 'success') {
      throw Object.assign(new Error(`swap reverted: ${hash}`), { gasCostWei, txHash: hash });
    }
    const me = this.account.address.toLowerCase();
    const transfers = parseEventLogs({ abi: erc20Abi, logs: rc.logs, eventName: 'Transfer' });
    let amountOut = 0n;
    for (const t of transfers) {
      if (t.address.toLowerCase() === tokenOut.toLowerCase() && t.args.to.toLowerCase() === me) amountOut += t.args.value;
    }
    return { txHash: hash, amountIn, amountOut, gasCostWei, latencyMs: Date.now() - t0 };
  }
}
