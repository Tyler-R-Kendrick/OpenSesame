/**
 * The connectivity monitor's sweep jitter: spread repeated sweeps so N
 * tabs never form a thundering herd.
 */

/** Spread repeated sweeps so N tabs never form a thundering herd. */
const JITTER = 0.15;

/** Uniform index in [0, max) without modulo bias (rejection sampling). */
function randomIndex(max: number): number {
  if (!Number.isInteger(max) || max <= 0) {
    throw new Error("randomIndex needs a positive bound");
  }
  const limit = Math.floor(2 ** 32 / max) * max;
  const buf = new Uint32Array(1);
  const view = new DataView(buf.buffer);
  let value: number;
  do {
    crypto.getRandomValues(buf);
    value = view.getUint32(0);
  } while (value >= limit);
  return value % max;
}

export function jittered(ms: number): number {
  const spread = ms * JITTER;
  const low = Math.ceil(ms - spread);
  const high = Math.floor(ms + spread);
  return low + randomIndex(high - low + 1);
}
