/**
 * First boot on a personal-local install: commit Access and browser-local IAM
 * when nothing is persisted yet, so Sent drops, Receipts and grants load
 * without a setup ceremony choice.
 */

import { PWA_DEFAULT_OPTIONALS } from "@opensesame/app-core/lib/capabilities/pwa-defaults.js";
import { capabilityPorts } from "@opensesame/app-core/lib/configuration/capabilities-ports.js";
import type { InstallationCapabilitySelection } from "@opensesame/capability-composition";
import {
  EMPTY_DRAFT,
  baseFromSnapshot,
  draftToSelection,
} from "../screens/capabilities/CapabilityDraft.js";

const SELECTED_DELIVERY: InstallationCapabilitySelection["delivery"] = {
  prefetch: "selected",
  offlineCache: "selected-only",
};

export async function ensurePwaDefaultCapabilities(): Promise<void> {
  const snapshot = capabilityPorts.compositionStore.getSnapshot();
  if (snapshot.selection !== null) return;
  if (snapshot.provenance !== "personal-local") return;
  if (snapshot.status !== "ready") return;

  const draft = { ...EMPTY_DRAFT, roots: [...PWA_DEFAULT_OPTIONALS] };
  const base = draftToSelection(
    draft,
    baseFromSnapshot(snapshot, new Date().toISOString()),
  );
  const selection = { ...base, delivery: SELECTED_DELIVERY };
  const receipt = capabilityPorts.buildConsentReceipt(
    capabilityPorts.previewPlan(selection),
    capabilityPorts.CAPABILITY_CATALOG,
    new Date().toISOString(),
  );
  await capabilityPorts.compositionStore.commit(selection, receipt);
}
