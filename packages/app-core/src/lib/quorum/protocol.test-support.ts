/**
 * Helpers for the protocol tests: a 3-of-5 circle, a controllable clock, and
 * the three steps a recovery is made of (raise a request, approve, release).
 */

import { buildApproval, buildRelease, seatOf } from "./approve.js";
import { QuorumLedger } from "./ledger.js";
import { startRecovery } from "./recover.js";
import { T0, type World, buildWorld, person } from "./world.test-support.js";

export const FIVE = ["Ada", "Ben", "Cy", "Dee", "Eli"] as const;

export const threeOfFive = () =>
  buildWorld({
    names: FIVE,
    keys: { Dee: 2 },
    groups: [{ id: "all", threshold: 3, members: FIVE }],
  });

export function clockAt(offsetSec: number) {
  const state = { t: T0.getTime() + offsetSec * 1000 };
  return {
    now: () => state.t,
    date: () => new Date(state.t),
    advanceTo: (seconds: number) => {
      state.t = T0.getTime() + seconds * 1000;
    },
  };
}

export async function raise(world: World, clock = clockAt(0)) {
  const pending = startRecovery({
    signedPolicy: world.created.signedPolicy,
    recipientLabel: "Tyler's new laptop",
    now: clock.date(),
  });
  const ledger = QuorumLedger.open(
    world.created.signedPolicy,
    pending.request,
    clock.now,
  );
  return { pending, ledger, clock };
}

export async function approve(
  world: World,
  name: string,
  r: Awaited<ReturnType<typeof raise>>,
) {
  const p = person(world, name);
  if (!p.holding) throw new Error("no holding");
  const approval = await buildApproval({
    seat: seatOf(p.holding),
    request: r.pending.request,
    ceremony: p.ceremony,
    now: r.clock.date(),
  });
  return { approval, outcome: await r.ledger.submitApproval(approval) };
}

export async function release(
  world: World,
  name: string,
  r: Awaited<ReturnType<typeof raise>>,
) {
  const p = person(world, name);
  if (!p.holding) throw new Error("no holding");
  const rel = await buildRelease({
    holding: p.holding,
    approvals: r.ledger.approvalList(),
    request: r.pending.request,
    ceremony: p.ceremony,
    now: r.clock.date(),
  });
  return { rel, outcome: await r.ledger.submitRelease(rel) };
}
