/**
 * Pre-flight check: verifies everything the bot needs WITHOUT trading or moving money.
 *   npm run selftest
 * Exit code 1 if anything critical fails. Run it after every config/key change.
 */
import { loadConfig } from '../config.js';
import { Venue } from '../cex/venue.js';
import { ChainWallet } from '../chain/wallet.js';
import { DexRouter } from '../chain/aggregators.js';
import { Notifier } from '../core/notifier.js';
import { toUnits, fromUnits } from '../core/utils.js';

let fails = 0;
let warns = 0;
const ok = (m: string) => console.log(`  ✅ ${m}`);
const bad = (m: string) => (fails++, console.log(`  ❌ ${m}`));
const warn = (m: string) => (warns++, console.log(`  ⚠️  ${m}`));
const em = (e: unknown) => (e instanceof Error ? e.message : String(e)).split('\n')[0].slice(0, 160);

async function permissions(v: Venue) {
  const ex = v.ex;
  try {
    if (v.id === 'binance') {
      const r = await ex.sapiGetAccountApiRestrictions();
      (r.enableSpotAndMarginTrading ? ok : bad)('permission: spot trading');
      (r.enableWithdrawals ? ok : bad)('permission: withdrawals');
      (r.ipRestrict ? ok : bad)('API key restricted to IP');
      (r.enableFutures ? ok : warn)('permission: futures (needed only for hedging on binance)');
    } else if (v.id === 'okx') {
      const r = await ex.privateGetAccountConfig();
      const perm = String(r?.data?.[0]?.perm ?? '');
      (perm.includes('trade') ? ok : bad)(`permission: trade (${perm})`);
      (perm.includes('withdraw') ? ok : bad)('permission: withdraw');
      (r?.data?.[0]?.ip ? ok : warn)('API key restricted to IP');
    } else if (v.id === 'bybit') {
      const r = await ex.privateGetV5UserQueryApi();
      const p = r?.result?.permissions ?? {};
      ((p.Spot ?? []).length ? ok : bad)('permission: spot trading');
      ((p.Wallet ?? []).some((x: string) => /withdraw/i.test(x)) || (p.Withdraw ?? []).length ? ok : bad)('permission: withdraw');
      (r?.result?.ips?.length && r.result.ips[0] !== '*' ? ok : warn)('API key restricted to IP');
    } else {
      warn(`permissions of ${v.id} cannot be read via API — confirm trade + withdraw (+ futures) + IP restriction manually`);
    }
  } catch (e) {
    warn(`could not read permissions: ${em(e)}`);
  }
}

async function main() {
  const cfg = loadConfig();
  console.log(`mode: ${cfg.dryRun ? 'DRY RUN' : 'LIVE'}   quote: ${cfg.quote}\n`);
  const account = ChainWallet.account(cfg.privateKey);

  // ── chains
  const wallets = new Map<string, ChainWallet>();
  for (const ch of Object.values(cfg.chains)) {
    console.log(`chain ${ch.name}`);
    const w = new ChainWallet(ch, account);
    try {
      const t0 = Date.now();
      const id = await w.pub.getChainId();
      (id === ch.chainId ? ok : bad)(`RPC chainId ${id} (${Date.now() - t0} ms)`);
      wallets.set(ch.name, w);
    } catch (e) {
      bad(`RPC unreachable: ${em(e)}`);
      continue;
    }
    if (!account) {
      (cfg.dryRun ? warn : bad)('no PRIVATE_KEY / PRIVATE_KEY_FILE');
      continue;
    }
    try {
      const nat = fromUnits(await w.nativeBalance(), 18);
      (nat >= ch.minNativeBalance ? ok : bad)(`gas balance ${nat} (min ${ch.minNativeBalance})`);
      const st = fromUnits(await w.balanceOf(ch.stable.address), ch.stable.decimals);
      (st > 0 ? ok : warn)(`${ch.stable.symbol} in wallet: ${st}`);
    } catch (e) {
      bad(`wallet balances: ${em(e)}`);
    }
  }
  if (account) console.log(`\nwallet address (must be whitelisted for withdrawals on every exchange): ${account.address}\n`);

  // ── DEX aggregators
  console.log('DEX aggregators');
  for (const name of cfg.strategy.aggregators) {
    const r = new DexRouter([name], cfg.kyberClientId, cfg.odosApiKey, cfg.strategy.dexSlippageBps);
    for (const [chainName, w] of wallets) {
      const a = cfg.assets.find((x) => x.chain === chainName);
      if (!a) continue;
      try {
        const q = await r.quote(w.cfg, w.cfg.stable.address, a.address, toUnits(cfg.strategy.sizing.minTradeQuote, w.cfg.stable.decimals));
        ok(`${name} @ ${chainName}: ${cfg.strategy.sizing.minTradeQuote} ${w.cfg.stable.symbol} → ${fromUnits(q.amountOut, a.decimals).toFixed(4)} ${a.symbol}`);
      } catch (e) {
        bad(`${name} @ ${chainName}: ${em(e)}`);
      }
    }
  }

  // ── exchanges
  for (const id of cfg.exchanges) {
    console.log(`\nexchange ${id}`);
    let v: Venue;
    try {
      v = new Venue(id, cfg.quote, cfg.withdrawFeeMode[id]);
      await v.init();
      ok('markets loaded');
    } catch (e) {
      bad(`init: ${em(e)}`);
      continue;
    }
    console.log(`  ℹ️  withdraw fee mode: ${v.feeMode}${v.feeMode === 'unknown' ? ' (safe default; confirm with first small withdrawal and set withdrawFeeMode)' : ''}`);
    if (!v.hasKeys) {
      (cfg.dryRun ? warn : bad)('no API keys');
      await v.close();
      continue;
    }
    try {
      ok(`auth ok — ${cfg.quote} trade: ${await v.free(cfg.quote, 'trade')}, fund: ${await v.free(cfg.quote, 'fund')}`);
    } catch (e) {
      bad(`auth/balance: ${em(e)}`);
      await v.close();
      continue;
    }
    await permissions(v);
    if (cfg.strategy.hedge.enabled && (cfg.strategy.hedge.venues.includes(id))) {
      try {
        ok(`perp margin (${cfg.quote}): ${await v.marginFree()}`);
      } catch (e) {
        warn(`perp margin not readable: ${em(e)}`);
      }
    }
    await v.refreshNetworks(cfg.assets, cfg.chains);
    const checked = new Set<string>();
    for (const a of cfg.assets) {
      const ch = cfg.chains[a.chain];
      for (const code of [a.symbol, ch.stable.symbol]) {
        const k = `${code}:${a.chain}`;
        if (checked.has(k) || (code === a.symbol && !v.hasMarket(a.symbol))) continue;
        checked.add(k);
        const n = v.net.get(k);
        if (!n) {
          warn(`${k}: network not found (tried ${ch.networkCodes.join('/')}) — this pair is skipped`);
          continue;
        }
        const line = `${k} via ${n.network}: deposit ${n.deposit ? 'on' : 'OFF'}, withdraw ${n.withdraw ? 'on' : 'OFF'}, fee ${n.withdrawFee}, minW ${n.withdrawMin}, minD ${n.depositMin}`;
        if (n.contractOk === false) bad(`${line} — CONTRACT MISMATCH, never traded`);
        else if (!Number.isFinite(n.withdrawFee)) warn(`${line} — fee unknown`);
        else ok(`${line}${n.contractOk === null ? ' (contract not exposed)' : ', contract ✓'}`);
        try {
          const addr = await v.depositAddress(code, n.network);
          ok(`${k} deposit address ${addr}`);
        } catch (e) {
          bad(`${k} deposit address: ${em(e)}`);
        }
      }
      if (cfg.strategy.hedge.enabled && v.hasPerp(a.symbol)) {
        v.fundingRate8h(a.symbol);
        await new Promise((r) => setTimeout(r, 1500));
        const f = v.fundingRate8h(a.symbol);
        console.log(`  ℹ️  ${a.symbol} perp funding/8h: ${f === undefined ? 'n/a' : (f * 100).toFixed(4) + '%'}`);
      }
    }
    await v.close();
  }

  // ── telegram
  console.log('\ntelegram');
  const n = new Notifier(cfg.telegram.token, cfg.telegram.chatId);
  if (n.enabled) {
    n.send('🧪 selftest: Telegram works');
    ok('test message sent — check the chat');
  } else warn('not configured (alerts and /commands disabled)');

  console.log('\nmanual checks (not visible via API):');
  console.log('  • wallet address above is in the WITHDRAWAL WHITELIST on every exchange');
  console.log('  • exchange sub-account dedicated to the bot; 2FA on the main account');
  console.log(`\nresult: ${fails} failed, ${warns} warnings`);
  await new Promise((r) => setTimeout(r, 1500));
  process.exit(fails ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
