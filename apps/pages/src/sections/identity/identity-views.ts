/**
 * Which Identity tabs are on the page.
 *
 * The Identity section is one component hosted by `identity.local-iam`, but
 * its tabs belong to three capabilities: Applications to local IAM itself,
 * Providers to `identity.federation`, and People / Agents / Organization to
 * `enterprise.directory-provisioning`. Devices belongs to both, because both
 * draw in it — the local device list and the directory's device approval —
 * and the count below is what lets a shared tab stay while either owner is
 * live. Each runtime contributes its tabs in `activate` and takes them back
 * in `dispose`; the tabs, the rail subtree and the URL fallback all read the
 * same set here.
 *
 * Nothing is enabled by default. A tab nobody contributed is not on the page,
 * so a capability that was never approved leaves no way into its panel —
 * which is the whole point of composing the section instead of drawing every
 * tab and hoping the panel behind it fails closed.
 */

import { useSyncExternalStore } from "react";

import { IDENTITY_VIEWS } from "@opensesame/app-core/lib/section-view-names.js";
export type IdentityView = (typeof IDENTITY_VIEWS)[number];

const counts = new Map<IdentityView, number>();
const listeners = new Set<() => void>();
let snapshot: readonly IdentityView[] = [];

function publish(): void {
  snapshot = IDENTITY_VIEWS.filter((view) => (counts.get(view) ?? 0) > 0);
  for (const listener of [...listeners]) listener();
}

/**
 * Put these tabs on the page. Returns the revoke; calling it twice is a
 * no-op. Two capabilities may name the same tab — it stays while either does.
 */
export function contributeIdentityViews(
  views: readonly IdentityView[],
): () => void {
  for (const view of views) counts.set(view, (counts.get(view) ?? 0) + 1);
  publish();
  let revoked = false;
  return () => {
    if (revoked) return;
    revoked = true;
    for (const view of views) {
      const next = (counts.get(view) ?? 1) - 1;
      if (next <= 0) counts.delete(view);
      else counts.set(view, next);
    }
    publish();
  };
}

/** The enabled tabs, in the section's canonical order. */
export function enabledIdentityViews(): readonly IdentityView[] {
  return snapshot;
}

export function subscribeIdentityViews(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useEnabledIdentityViews(): readonly IdentityView[] {
  return useSyncExternalStore(subscribeIdentityViews, enabledIdentityViews);
}

/** Test-only: forget every contribution. */
export function resetIdentityViewsForTests(): void {
  counts.clear();
  publish();
}
