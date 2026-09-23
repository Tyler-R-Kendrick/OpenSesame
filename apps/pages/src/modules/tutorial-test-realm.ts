/**
 * Test-only: declare a capability's authored tutorial descriptors the way
 * the loader would, through the real store and registry, so a panel that
 * mounts a contributed guide target (`settings.model-provider`,
 * `nav.connections`, …) can render in a unit test. Nothing here is a second
 * registry: it boots the fixture realm, commits a plan that approves the
 * capability, binds a child lease to it and registers through
 * `registerContribution`. The returned function tears it all down.
 *
 * The fixture realm swaps `kvSeams.kvGet` for the harness's in-memory
 * "durable" map while it boots and commits. That map is not what `kvSet`
 * writes to, so leaving the seam installed would make every later
 * `saveSettings` in the suite invisible to `loadSettings` — a panel would
 * read the deployment's defaults instead of what the test just saved. The
 * storage seams are therefore handed back before this returns, and again on
 * teardown after the second `freshRealm`.
 */

import {
  bootPersonalLocal,
  draftFor,
  freshRealm,
} from "@opensesame/app-core/lib/capabilities/__tests__/harness.js";
import { deriveLease } from "@opensesame/app-core/lib/capabilities/lease.js";
import {
  bindLeaseToCapability,
  registerContribution,
} from "@opensesame/app-core/lib/capabilities/registry.js";
import { compositionStore } from "@opensesame/app-core/lib/capabilities/store.js";
import { kvSeams } from "@opensesame/app-core/lib/kv.js";
import type { TutorialContributions } from "./tutorial-contributions.js";

export async function declareTutorialForTest(
  capability: string,
  contributions: TutorialContributions,
): Promise<() => void> {
  const storage = { ...kvSeams };
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
  Object.assign(kvSeams, storage);
  return () => {
    child.abort("test-teardown");
    freshRealm();
    Object.assign(kvSeams, storage);
  };
}
