import { easeBack, easeInOutCubic } from "./easing.js";
import type { RingSpec } from "./layout.js";

export type RingSpin = (u: number) => number;

export function ringPosition(q: RingSpec, t: number): number {
  if (q.t0 < 0) return q.to;
  const u = Math.min(1, (t - q.t0) / q.dur);
  if (u >= 1) {
    q.t0 = -1;
    q.from = q.to;
    return q.to;
  }
  const spin = q.spin;
  const eased = spin ? spin(u) : easeBack(u);
  return q.from + (q.to - q.from) * eased;
}

export function tickIdleRing(q: RingSpec, t: number, phase: string): void {
  if (phase !== "idle" || q.t0 >= 0 || t < q.next) return;
  const steps = q.rand() < 0.15 ? 2 : 1;
  q.from = q.to;
  q.to = q.to + q.dir * steps;
  q.t0 = t;
  q.dur = 120 + 40 * steps;
  q.spin = undefined;
  let wait = q.period * (0.85 + q.rand() * 0.3);
  if (q.rand() < 0.2) wait *= 2.2;
  if (q.rand() < 0.08) q.dir *= -1;
  q.next = t + q.dur + wait;
  q.dirty = true;
}

export function alignRings(
  rings: RingSpec[],
  t0: number,
  tClickMs: number,
): void {
  for (let i = 0; i < rings.length; i += 1) {
    const q = rings[i];
    const target = q.jt;
    const cur = ((Math.round(q.to) % q.N) + q.N) % q.N;
    let dist =
      q.dir > 0 ? (target - cur + q.N) % q.N : -((cur - target + q.N) % q.N);
    if (Math.abs(dist) < Math.min(8, q.N / 4)) dist += q.dir * q.N;
    const fromK = Math.round(q.to);
    const toK = fromK + dist;
    const end = 500 + (tClickMs - 500) * (i / (rings.length - 1));
    q.from = fromK;
    q.to = toK;
    q.t0 = t0;
    q.dur = end;
    const span = toK - fromK;
    q.spin = (u: number) => {
      if (!span) return 1;
      const lead = 1 - 110 / end;
      if (u < lead) {
        const e = easeInOutCubic(u / lead);
        return (Math.floor(e * (Math.abs(span) - 1)) * Math.sign(span)) / span;
      }
      const v = (u - lead) / (1 - lead);
      return (Math.abs(span) - 1 + easeBack(v)) / Math.abs(span);
    };
    q.dirty = true;
  }
}
