export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Round a quantity DOWN to the exchange step size (avoids float artefacts). */
export function floorToStep(qty: number, step: number): number {
  if (step <= 0) return qty;
  const decimals = Math.max(0, Math.round(-Math.log10(step)));
  const floored = Math.floor(qty / step + 1e-9) * step;
  return Number(floored.toFixed(decimals));
}

export function toUnits(amount: number, decimals: number): bigint {
  // via string to avoid float -> bigint precision loss on large decimals
  const [i, f = ''] = amount.toFixed(decimals).split('.');
  return BigInt(i + f.padEnd(decimals, '0').slice(0, decimals));
}

export function fromUnits(amount: bigint, decimals: number): number {
  const neg = amount < 0n;
  const abs = neg ? -amount : amount;
  const s = abs.toString().padStart(decimals + 1, '0');
  const v = Number(`${s.slice(0, s.length - decimals)}.${s.slice(s.length - decimals)}`);
  return neg ? -v : v;
}

export async function retry<T>(fn: () => Promise<T>, attempts: number, baseDelayMs: number): Promise<T> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      if (i < attempts - 1) await sleep(baseDelayMs * 2 ** i);
    }
  }
  throw last;
}
