/**
 * Test harness clock: Playwright contracts set `globalThis.__vt` to sample
 * mid-animation frames. Production callers always hit `performance.now()`.
 */

type ClockHost = {
  __vt?: number;
  matchMedia?: (query: string) => { matches: boolean };
  performance: { now: () => number };
};

function clockHost(): ClockHost {
  // SAFETY: ClockHost is the verified harness contract for optional `__vt` on globalThis (wordmark-contract.mjs).
  return globalThis as ClockHost;
}

/** Wall time, or `__vt` when a verify/visual harness injected one. */
export function injectedNowMs(): number {
  const host = clockHost();
  const value = host.__vt;
  if (value !== undefined && Number.isFinite(value)) return value;
  return host.performance.now();
}

/** `prefers-reduced-motion: reduce`, false when matchMedia is absent. */
export function prefersReducedMotion(): boolean {
  return (
    clockHost().matchMedia?.("(prefers-reduced-motion: reduce)").matches ===
    true
  );
}
