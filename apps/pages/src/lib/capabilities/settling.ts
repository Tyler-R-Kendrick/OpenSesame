/**
 * Whether the plan is still coming up.
 *
 * An approved capability registers its routes, sections and commands when
 * its module activates, which happens after the plan resolves. So there is
 * a window in which the router can match a path the installation genuinely
 * has and find nothing registered for it — and a decision taken in that
 * window is the wrong one. A cold deep link is exactly that case: the
 * browser-local consent popup opens straight at `/identity/authorize`, the
 * route's owner had not activated yet, and the fallback redirected the
 * popup to the vault, which ends the sign-in it was opened to complete.
 *
 * `approved-not-loaded` and `loading` are the two lifecycles that say "this
 * one is still on its way"; everything else has settled, including the
 * failures, so a capability that cannot load never holds the door open.
 */

import type {
  CapabilityId,
  CapabilityLifecycle,
} from "@opensesame/capability-composition";

const PENDING: readonly CapabilityLifecycle[] = [
  "approved-not-loaded",
  "loading",
];

export function planIsSettling(snapshot: {
  plan: { approvedCapabilities: readonly CapabilityId[] } | null;
  lifecycle: Readonly<Partial<Record<CapabilityId, CapabilityLifecycle>>>;
}): boolean {
  const approved = snapshot.plan?.approvedCapabilities ?? [];
  return approved.some((id) => {
    const state = snapshot.lifecycle[id];
    return state !== undefined && PENDING.includes(state);
  });
}
