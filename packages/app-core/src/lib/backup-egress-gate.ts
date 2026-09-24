/**
 * What git backup may do on the network now (ADR 0138).
 *
 * Git backup is always on by default, and always on is not a way round the
 * operator's policy (ADR 0135 §1):
 *
 *  - an operator may withdraw it (`prohibited`); then it makes no call at
 *    all, not even one a person asks for;
 *  - a plan that does not allow external services — the Family preset, a
 *    managed policy, an unverified one, or no plan yet — holds its
 *    *automatic* calls: the observer's start, its webhook poll and the push
 *    after a vault mutation. A sync a person asks for by hand still runs;
 *  - a non-empty `allowedServiceOrigins` is an allowlist: every backup call,
 *    automatic or not, goes only to an origin on it.
 *
 * Every surface that can reach the network through git backup — the
 * capability's background job, a Settings tile reading the status, a
 * target being enabled, a manual sync — goes through here.
 */

import type { NetworkPolicy } from "@opensesame/capability-composition";
import { compositionStore } from "./capabilities/store.js";

const CAPABILITY = "backup.git-remote";

export const backupEgressGate = {
  /** The plan's network envelope; null before a plan resolves. */
  network: (): NetworkPolicy | null =>
    compositionStore.getSnapshot().plan?.network ?? null,
  /** Whether this plan runs git backup at all. */
  running: (): boolean =>
    compositionStore.getSnapshot().plan?.capabilities[CAPABILITY]?.approved ===
    true,
  /** Whether git backup may make a call on its own now. */
  allowed: (): boolean =>
    backupEgressGate.running() &&
    backupEgressGate.network()?.externalServices === "allow",
};

/**
 * Whether a backup call may go to `url`: git backup runs, and the origin is
 * on the operator's allowlist when there is one. An unreadable URL is not.
 */
export function backupOriginAllowed(url: string): boolean {
  if (!backupEgressGate.running()) return false;
  const allowlist = backupEgressGate.network()?.allowedServiceOrigins ?? [];
  if (allowlist.length === 0) return true;
  try {
    return allowlist.includes(new URL(url).origin);
  } catch {
    return false;
  }
}
