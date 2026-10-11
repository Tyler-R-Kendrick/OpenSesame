/**
 * Personal-local PWA first-boot defaults (D2). Invoked from Pages `bootCore`
 * after `compositionStore.boot`, not from the store itself, to keep the
 * composition store module within the shipped bundle budget.
 */

import {
  type InstallationCapabilitySelection,
  buildConsentReceipt,
} from "@opensesame/capability-composition";
import { storeSeams } from "./store-seams.js";
import type { CompositionStore } from "./store.js";

export async function applyPersonalLocalPwaDefaults(
  store: CompositionStore,
): Promise<void> {
  const snap = store.getSnapshot();
  const catalog = store.catalog();
  if (
    snap.selection !== null ||
    snap.provenance !== "personal-local" ||
    !snap.plan ||
    !catalog
  ) {
    return;
  }
  const at = storeSeams.now();
  const id = snap.plan.identity;
  const draft: InstallationCapabilitySelection = {
    schemaVersion: 1,
    kind: "InstallationCapabilitySelection",
    instanceId: id.instanceId,
    installationId: id.installationId,
    basePolicyRevision: id.policyRevision,
    revision: `p${at}`,
    acceptedRequired: [],
    selectedOptional: ["access.authority", "identity.local-iam"],
    chosenAlternatives: {},
    delivery: { prefetch: "selected", offlineCache: "selected-only" },
  };
  await store.commit(
    draft,
    buildConsentReceipt(store.preview(draft), catalog, at),
  );
}
