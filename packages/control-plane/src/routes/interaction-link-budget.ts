import { createHash } from "node:crypto";
import type { Context } from "hono";
import type { Variables } from "../middleware/context.js";

/*
 * The short link's pacing (ADR 0086), kept out of the handoff routes so the
 * routes file holds routes. Both budgets are module-global on purpose: they
 * outlive a request and are keyed by client-influenced values.
 */

/**
 * A sliding-window budget for the unauthenticated short link.
 *
 * Module-global because it must outlive a request, bounded because it is keyed
 * by client-influenced values, and wall-clock rather than `ctx.clock()` because
 * pacing is about real elapsed time and a test's frozen clock must not be able
 * to hold a window open.
 *
 * This is not the enumeration defence — a reference carries 144 bits of
 * randomness *and* a MAC, so guessing is not a strategy anybody has, and a
 * forged reference is refused before any database lookup. What the budget
 * actually buys is that the endpoint cannot be turned into a free HMAC
 * verification loop against the deployment pepper.
 *
 * **Only unverifiable references spend it.** That asymmetry is the whole
 * design, and getting it backwards is worse than having no budget at all. A
 * caller holding a reference that verifies was handed the link; a caller
 * sending one that does not is probing. If both spent from a shared bucket,
 * an attacker rotating the two headers this fingerprint is built from — which
 * costs them nothing — could exhaust a global cap and every genuine QR scan on
 * the instance would answer 429. The evadable limit would constrain honest
 * users and the unevadable one would deny them, which is precisely inverted
 * for a feature whose premise is that somebody is standing in front of a
 * screen right now.
 *
 * So verification comes first, it is one HMAC and touches no database, and a
 * genuine link is never paced by what somebody else is doing.
 */
const LINK_WINDOW_MS = 60_000;
const LINK_GLOBAL_BUDGET = 3_000;
const LINK_CLIENT_BUDGET = 240;
const LINK_FENCE_ENTRIES = 4_096;
const linkAttempts = new Map<string, number[]>();

/** Clear both budgets. Test-only: module-global state outlives an app. */
export function resetLinkBudgets(): void {
  linkAttempts.clear();
  referenceAttempts.clear();
}

export function consumeLinkBudget(
  c: Context<{ Variables: Variables }>,
): boolean {
  const now = Date.now();
  for (const [key, values] of linkAttempts) {
    const live = values.filter((at) => now - at < LINK_WINDOW_MS);
    if (live.length === 0) linkAttempts.delete(key);
    else if (live.length !== values.length) linkAttempts.set(key, live);
  }
  while (linkAttempts.size > LINK_FENCE_ENTRIES) {
    const oldest = linkAttempts.keys().next().value;
    if (oldest === undefined) break;
    linkAttempts.delete(oldest);
  }
  const fingerprint = createHash("sha256")
    .update(c.req.header("user-agent") ?? "")
    .update("|")
    .update(c.req.header("x-forwarded-for") ?? c.req.header("origin") ?? "")
    .digest("hex")
    .slice(0, 16);
  const global = linkAttempts.get("__global__") ?? [];
  const client = linkAttempts.get(fingerprint) ?? [];
  if (
    global.length >= LINK_GLOBAL_BUDGET ||
    client.length >= LINK_CLIENT_BUDGET
  ) {
    return false;
  }
  linkAttempts.set("__global__", [...global, now]);
  linkAttempts.set(fingerprint, [...client, now]);
  return true;
}

/**
 * Per-reference pacing for links that verify.
 *
 * Generous, because a real scan is followed by a page load, a sign-in and a
 * poll or two, and several people may hold the same link. Tight enough that
 * the endpoint is not a free status feed on somebody else's approval.
 */
const REFERENCE_BUDGET = 120;
const referenceAttempts = new Map<string, number[]>();

export function consumeReferenceBudget(ref: string): boolean {
  const now = Date.now();
  // Same shedding discipline as the probing budget: the map is keyed by a
  // value a caller supplies, so it must be bounded whatever they send.
  for (const [key, values] of referenceAttempts) {
    const live = values.filter((at) => now - at < LINK_WINDOW_MS);
    if (live.length === 0) referenceAttempts.delete(key);
    else if (live.length !== values.length) referenceAttempts.set(key, live);
  }
  while (referenceAttempts.size > LINK_FENCE_ENTRIES) {
    const oldest = referenceAttempts.keys().next().value;
    if (oldest === undefined) break;
    referenceAttempts.delete(oldest);
  }
  const seen = referenceAttempts.get(ref) ?? [];
  if (seen.length >= REFERENCE_BUDGET) return false;
  referenceAttempts.set(ref, [...seen, now]);
  return true;
}
