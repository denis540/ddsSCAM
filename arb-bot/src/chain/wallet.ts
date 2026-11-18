import {
  createPublicClient, createWalletClient, http, parseAbi, parseEventLogs, maxUint256, defineChain,
  type Address, type Hex, type PublicClient, type WalletClient, type PrivateKeyAccount, type Chain,
} from 'viem';
import { privateKeyToAccount, nonceManager } from 'viem/accounts';
import type { ChainCfg } from '../config.js';
import { log } from '../core/logger.js';

export const erc20Abi = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function transfer(address to, uint256 amount) returns (bool)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
]);

/** One EVM chain: reads, ERC20 transfers/approvals and raw tx sending with a shared nonce manager. */
export class ChainWallet {
  readonly pub: PublicClient;
  private wallet?: WalletClient;
  private chain: Chain;

  constructor(readonly cfg: ChainCfg, readonly account?: PrivateKeyAccount) {
    this.chain = defineChain({
      id: cfg.chainId, name: cfg.name,
      nativeCurrency: { name: 'native', symbol: 'NATIVE', decimals: 18 },
      rpcUrls: { default: { http: [cfg.rpc] } },
    });
    this.pub = createPublicClient({ chain: this.chain, transport: http(cfg.rpc, { batch: { wait: 0 }, timeout: 8000, retryCount: 2 }) }) as PublicClient;
    if (account) this.wallet = createWalletClient({ account, chain: this.chain, transport: http(cfg.rpc, { timeout: 15000 }) });
  }

  static account(pk?: Hex) {
    return pk ? privateKeyToAccount(pk, { nonceManager }) : undefined;
  }

  get address(): Address {
    if (!this.account) throw new Error('wallet not configured');
    return this.account.address;
  }

  balanceOf(token: Address): Promise<bigint> {
    return this.pub.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [this.address] });
  }

  nativeBalance(): Promise<bigint> {
    return this.pub.getBalance({ address: this.address });
  }

  async ensureApproval(token: Address, spender: Address, amount: bigint) {
    const allowance = await this.pub.readContract({ address: token, abi: erc20Abi, functionName: 'allowance', args: [this.address, spender] });
    if (allowance >= amount) return;
    log.info('approve', { chain: this.cfg.name, token, spender });
    const hash = await this.wallet!.writeContract({
      account: this.account!, chain: this.chain, address: token, abi: erc20Abi, functionName: 'approve', args: [spender, maxUint256],
    });
    await this.confirm(hash);
  }

  /** Broadcast ERC20 transfer; returns hash immediately (caller persists it before waiting). */
  sendErc20(token: Address, to: Address, amount: bigint): Promise<Hex> {
    return this.wallet!.writeContract({
      account: this.account!, chain: this.chain, address: token, abi: erc20Abi, functionName: 'transfer', args: [to, amount],
    });
  }

  sendRaw(to: Address, data: Hex, gas?: bigint): Promise<Hex> {
    return this.wallet!.sendTransaction({ account: this.account!, chain: this.chain, to, data, gas });
  }

  async confirm(hash: Hex) {
    const rc = await this.pub.waitForTransactionReceipt({ hash, timeout: 180_000, pollingInterval: 500 });
    if (rc.status !== 'success') throw new Error(`tx reverted ${hash}`);
    return rc;
  }

  /** Sum of `token` transferred to us inside a tx (exact swap output, unaffected by other activity). */
  async receivedInTx(hash: Hex, token: Address): Promise<bigint> {
    const rc = await this.confirm(hash);
    const me = this.address.toLowerCase();
    let sum = 0n;
    for (const t of parseEventLogs({ abi: erc20Abi, logs: rc.logs, eventName: 'Transfer' })) {
      if (t.address.toLowerCase() === token.toLowerCase() && t.args.to.toLowerCase() === me) sum += t.args.value;
    }
    return sum;
  }
}
