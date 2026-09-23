/**
 * One change to what this installation runs, from switch to commit.
 *
 * A feature switch and an Advanced row both end here: they propose the
 * optional roots the installation should have, the store reviews that
 * selection, and only Apply commits it with a consent receipt — the same
 * ceremony whether one capability or a whole feature moves. Nothing is
 * fetched or activated before Apply (CONSENT-01).
 */

import type { FeatureProposal } from "@opensesame/app-core/lib/capabilities/features.js";
import {
  CAPABILITY_CATALOG,
  buildConsentReceipt,
  compositionStore,
  previewPlan,
  viewOutcome,
} from "@opensesame/app-core/lib/configuration/capabilities-ports.js";
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

const OPTIONAL = new Set(
  CAPABILITY_CATALOG.capabilities
    .filter((entry) => entry.tier === "optional")
    .map((entry) => entry.id),
);

/** The optional roots the installation has chosen; always-on ids never count. */
export function currentRoots(
  selection: { selectedOptional: readonly CapabilityId[] } | null,
): CapabilityId[] {
  return (selection?.selectedOptional ?? []).filter((id) => OPTIONAL.has(id));
}

export function useCapabilityChange() {
  const snapshot = useComposition();
  const [pending, setPending] = useState<FeatureProposal | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const selectionFor = (proposal: FeatureProposal) =>
    draftToSelection(
      {
        ...draftFromSelection(snapshot.selection, "customize"),
        roots: proposal.roots.filter((id) => OPTIONAL.has(id)),
        alternatives: proposal.alternatives,
      },
      baseFromSnapshot(snapshot, capabilitiesPanelSeams.now()),
    );
  const review = pending
    ? compositionStore.review(selectionFor(pending))
    : null;

  /** Commit the roots the switch proposed — added or removed, one ceremony. */
  async function apply(): Promise<void> {
    if (!pending) return;
    setBusy(true);
    try {
      const selection = selectionFor(pending);
      const plan = previewPlan(selection);
      const receipt = buildConsentReceipt(
        plan,
        CAPABILITY_CATALOG,
        capabilitiesPanelSeams.now(),
      );
      const outcome = viewOutcome(
        await compositionStore.commit(selection, receipt),
        snapshot.durability,
      );
      setNotice(
        outcome.status === "durable" || outcome.status === "session-only"
          ? null
          : `${outcome.status} · ${outcome.message}`,
      );
    } finally {
      setBusy(false);
      setPending(null);
    }
  }

  const current: FeatureProposal = {
    roots: currentRoots(snapshot.selection),
    alternatives: snapshot.selection?.chosenAlternatives ?? {},
  };
  return {
    snapshot,
    current,
    review,
    busy,
    notice,
    propose: (proposal: FeatureProposal) => setPending(proposal),
    cancel: () => setPending(null),
    apply,
  };
}

export type CapabilityChange = ReturnType<typeof useCapabilityChange>;
