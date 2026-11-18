import { monitorEventLoopDelay } from 'node:perf_hooks';

/**
 * Main-thread event-loop delay: how long a ready-to-run callback (e.g. "send
 * the order now") waits behind other work. Healthy: p99 < 10 ms.
 */
const h = monitorEventLoopDelay({ resolution: 10 });
h.enable();

export function loopLag(reset = false) {
  const r = { lagP50Ms: h.percentile(50) / 1e6, p99: h.percentile(99) / 1e6, lagMaxMs: h.max / 1e6 };
  if (reset) h.reset();
  return r;
}
