/**
 * Test-only: declare a capability's authored tutorial descriptors the way
 * the loader would, through the real store and registry, so a panel that
 * mounts a contributed guide target (`settings.model-provider`,
 * `nav.connections`, …) can render in a unit test. Nothing here is a second
 * registry: it boots the fixture realm, commits a plan that approves the
 * capability, binds a child lease to it and registers through
 * `registerContribution`. The returned function tears it all down.
 */

import {
  bootPersonalLocal,
  draftFor,
  freshRealm,
} from "../lib/capabilities/__tests__/harness.js";
import { deriveLease } from "../lib/capabilities/lease.js";
import {
  bindLeaseToCapability,
  registerContribution,
} from "../lib/capabilities/registry.js";
import { compositionStore } from "../lib/capabilities/store.js";
import type { TutorialContributions } from "./tutorial-contributions.js";

export async function declareTutorialForTest(
  capability: string,
  contributions: TutorialContributions,
): Promise<() => void> {
  freshRealm();
  await bootPersonalLocal();
  const { draft, receipt } = draftFor(compositionStore, [capability], "r1");
  await compositionStore.commit(draft, receipt);
  const child = deriveLease(compositionStore.currentLease());
  bindLeaseToCapability(child.lease, capability);
  for (const target of contributions.targets ?? []) {
    registerContribution("tutorial-target", target, child.lease);
  }
  for (const goal of contributions.goals ?? []) {
    registerContribution("tutorial-goal", goal, child.lease);
  }
  for (const route of contributions.routes ?? []) {
    registerContribution("tutorial-route", route, child.lease);
  }
  return () => {
    child.abort("test-teardown");
    freshRealm();
  };
}
