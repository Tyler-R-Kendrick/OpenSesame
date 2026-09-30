/**
 * One change to what this installation runs, from switch to commit.
 *
 * A section's switch and a capability tile's switch both end here: they
 * commit the optional roots in place, with the consent receipt the plan
 * earns. The page stays on its connector list. Nothing is fetched or
 * activated before that commit (CONSENT-01).
 */

import type { FeatureProposal } from "@opensesame/app-core/lib/capabilities/features.js";
import { capabilityPorts } from "@opensesame/app-core/lib/configuration/capabilities-ports.js";
import type { CapabilityId } from "@opensesame/capability-composition";
import { useState } from "react";
import { useComposition } from "../../bindings/capabilities.js";
import {
  baseFromSnapshot,
  draftFromSelection,
  draftToSelection,
} from "../../screens/capabilities/CapabilityDraft.js";

export const capabilitiesPanelSeams = {
  reload: () => window.location.reload(),
  now: () => new Date().toISOString(),
};

/** The optional roots the installation has chosen; always-on ids never count. */
export function currentRoots(
  selection: { selectedOptional: readonly CapabilityId[] } | null,
): CapabilityId[] {
  // Read at call time: the catalog is the seam's, whichever stands behind it.
  const optional = new Set(
    capabilityPorts.CAPABILITY_CATALOG.capabilities
      .filter((entry) => entry.tier === "optional")
      .map((entry) => entry.id),
  );
  return (selection?.selectedOptional ?? []).filter((id) => optional.has(id));
}

type Snapshot = ReturnType<typeof useComposition>;

/** The selection a proposal makes of the installation's current one. */
export function selectionFor(snapshot: Snapshot, proposal: FeatureProposal) {
  return draftToSelection(
    {
      ...draftFromSelection(snapshot.selection, "customize"),
      roots: currentRoots({ selectedOptional: proposal.roots }),
      alternatives: proposal.alternatives,
    },
    baseFromSnapshot(snapshot, capabilitiesPanelSeams.now()),
  );
}

/**
 * Commit a proposal with the consent receipt its plan earns — the one
 * ceremony every switch, and the join road's consent, ends in. Returns the
 * notice to show, or null when the commit landed.
 */
export async function commitProposal(
  snapshot: Snapshot,
  proposal: FeatureProposal,
): Promise<string | null> {
  const selection = selectionFor(snapshot, proposal);
  const plan = capabilityPorts.previewPlan(selection);
  const receipt = capabilityPorts.buildConsentReceipt(
    plan,
    capabilityPorts.CAPABILITY_CATALOG,
    capabilitiesPanelSeams.now(),
  );
  const outcome = capabilityPorts.viewOutcome(
    await capabilityPorts.compositionStore.commit(selection, receipt),
    snapshot.durability,
  );
  return outcome.status === "durable" || outcome.status === "session-only"
    ? null
    : `${outcome.status} · ${outcome.message}`;
}

export function useCapabilityChange() {
  const snapshot = useComposition();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  /** The switch commits in place. The page stays on its connector list. */
  function propose(proposal: FeatureProposal): void {
    setBusy(true);
    void commitProposal(snapshot, proposal)
      .then((next) => setNotice(next))
      .finally(() => setBusy(false));
  }

  const current: FeatureProposal = {
    roots: currentRoots(snapshot.selection),
    alternatives: snapshot.selection?.chosenAlternatives ?? {},
  };
  return {
    snapshot,
    current,
    review: null,
    busy,
    notice,
    propose,
    cancel: () => setNotice(null),
    apply: () => Promise.resolve(),
  };
}

export type CapabilityChange = ReturnType<typeof useCapabilityChange>;
