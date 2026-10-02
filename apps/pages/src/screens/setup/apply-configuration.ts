/**
 * Commit Minimal, Default or Full. Custom never comes through
 * here: it opens the tabbed ceremony, whose Apply is the only
 * other store commit.
 */

import { capabilityPorts } from "@opensesame/app-core/lib/configuration/capabilities-ports.js";
import type { InstallationCapabilitySelection } from "@opensesame/capability-composition";
import {
  EMPTY_DRAFT,
  baseFromSnapshot,
  draftToSelection,
  fullDraft,
  minimalDraft,
} from "../capabilities/CapabilityDraft.js";
import { DEFAULT_EXTENSIONS } from "./default-extensions.js";

export type AppliedConfiguration = "minimal" | "default" | "full";

const SELECTED_DELIVERY: InstallationCapabilitySelection["delivery"] = {
  prefetch: "selected",
  offlineCache: "selected-only",
};

export async function applySetupConfiguration(
  id: AppliedConfiguration,
): Promise<"applied" | "refused"> {
  const snapshot = capabilityPorts.compositionStore.getSnapshot();
  const draft =
    id === "minimal"
      ? minimalDraft()
      : id === "full"
        ? fullDraft(capabilityPorts.CAPABILITY_CATALOG, snapshot.plan)
        : { ...EMPTY_DRAFT, roots: DEFAULT_EXTENSIONS };
  const base = draftToSelection(
    draft,
    baseFromSnapshot(snapshot, new Date().toISOString()),
  );
  // Only Minimal keeps the shell's own delivery: everything that
  // installs a capability prefetches and caches what it selected.
  const selection =
    id === "minimal" ? base : { ...base, delivery: SELECTED_DELIVERY };
  const receipt = capabilityPorts.buildConsentReceipt(
    capabilityPorts.previewPlan(selection),
    capabilityPorts.CAPABILITY_CATALOG,
    new Date().toISOString(),
  );
  const result = await capabilityPorts.compositionStore.commit(
    selection,
    receipt,
  );
  const outcome = capabilityPorts.viewOutcome(result, snapshot.durability);
  return outcome.status === "durable" || outcome.status === "session-only"
    ? "applied"
    : "refused";
}
