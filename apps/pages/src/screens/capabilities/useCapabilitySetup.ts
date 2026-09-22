/**
 * The setup tab's state machine: roads → purpose → cards → review → apply.
 *
 * Every transition before Apply is pure draft state. Apply is the only call
 * that reaches the store's `commit`, and it goes with the receipt built from
 * the reviewed plan (CONSENT-03). Cancel drops the draft and nothing else
 * (CONSENT-02).
 */

import type {
  CapabilityId,
  CompositionChangeReview,
  InstallationCapabilitySelection,
} from "@opensesame/capability-composition";
import { useCallback, useMemo, useState } from "react";
import {
  CAPABILITY_CATALOG,
  type CapabilityPreset,
  type OutcomeView,
  buildConsentReceipt,
  compositionStore,
  previewPlan,
  useComposition,
  viewOutcome,
} from "../../lib/configuration/capabilities-ports.js";
import {
  type CapabilityDraft,
  acceptRequired,
  alternativesFor,
  applyPreset,
  baseFromSnapshot,
  chooseAlternative,
  draftFromSelection,
  draftToSelection,
  minimalDraft,
  replaceRoot,
  toggleRoot,
} from "./CapabilityDraft.js";

export type SetupStage =
  | "roads"
  | "join"
  | "purpose"
  | "cards"
  | "review"
  | "outcome";

export const capabilitySetupSeams = {
  now: () => new Date().toISOString(),
};

type DraftEditors = Readonly<{
  preset: (preset: CapabilityPreset) => void;
  toggle: (id: CapabilityId) => void;
  alternative: (slot: string, id: CapabilityId) => void;
  replace: (from: CapabilityId, to: CapabilityId) => void;
  review: () => void;
}>;

/**
 * Every edit is a pure transform of the draft. `replace` and `review` are
 * the only two that open the review, and neither commits anything.
 */
function useDraftEditors(args: {
  draft: CapabilityDraft | null;
  setDraft: (next: (current: CapabilityDraft | null) => CapabilityDraft) => void;
  setStage: (stage: SetupStage) => void;
  openReview: (next: CapabilityDraft) => void;
  catalog: typeof CAPABILITY_CATALOG;
  plan: ReturnType<typeof useComposition>["plan"];
}): DraftEditors {
  const { draft, setDraft, setStage, openReview, catalog, plan } = args;
  return useMemo(
    () => ({
      preset: (preset: CapabilityPreset) => {
        setDraft((current) =>
          applyPreset(current ?? draftFromSelection(null, "customize"), preset, plan),
        );
        setStage("cards");
      },
      toggle: (id: CapabilityId) =>
        setDraft((current) => (current ? toggleRoot(current, id) : EMPTY)),
      alternative: (slot: string, id: CapabilityId) =>
        setDraft((current) =>
          current ? chooseAlternative(current, slot, id) : EMPTY,
        ),
      replace: (from: CapabilityId, to: CapabilityId) => {
        if (draft) openReview(replaceRoot(draft, from, to, catalog));
      },
      review: () => {
        if (draft) openReview(draft);
      },
    }),
    [catalog, draft, openReview, plan, setDraft, setStage],
  );
}

const EMPTY: CapabilityDraft = draftFromSelection(null, "customize");

export function useCapabilitySetup(initialJoin: boolean) {
  const snapshot = useComposition();
  const catalog = CAPABILITY_CATALOG;
  const requiredNotAccepted = snapshot.plan?.consent.requiredNotAccepted ?? [];
  const managed =
    snapshot.provenance !== "personal-local" ||
    (snapshot.policy?.capabilities.required.length ?? 0) > 0;
  const [stage, setStage] = useState<SetupStage>(
    initialJoin && requiredNotAccepted.length > 0 ? "join" : "roads",
  );
  const [draft, setDraft] = useState<CapabilityDraft | null>(null);
  const [review, setReview] = useState<CompositionChangeReview | null>(null);
  const [outcome, setOutcome] = useState<OutcomeView | null>(null);
  const [busy, setBusy] = useState(false);

  const selectionOf = useCallback(
    (next: CapabilityDraft): InstallationCapabilitySelection =>
      draftToSelection(
        next,
        baseFromSnapshot(snapshot, capabilitySetupSeams.now()),
      ),
    [snapshot],
  );

  const openReview = useCallback(
    (next: CapabilityDraft) => {
      setDraft(next);
      setReview(compositionStore.review(selectionOf(next)));
      setStage("review");
    },
    [selectionOf],
  );

  const cancel = useCallback(() => {
    setDraft(null);
    setReview(null);
    setOutcome(null);
    setStage("roads");
  }, []);

  const roads = useMemo(
    () => ({
      minimal: () => openReview(minimalDraft()),
      customize: () => {
        setDraft(draftFromSelection(snapshot.selection, "customize"));
        setStage(managed ? "cards" : "purpose");
      },
      join: () => setStage("join"),
    }),
    [managed, openReview, snapshot.selection],
  );

  const accept = useCallback(() => {
    setDraft(
      acceptRequired(
        draftFromSelection(snapshot.selection, "join"),
        requiredNotAccepted,
      ),
    );
    setStage("cards");
  }, [requiredNotAccepted, snapshot.selection]);

  const edit = useDraftEditors({
    draft,
    setDraft,
    setStage,
    openReview,
    catalog,
    plan: snapshot.plan,
  });

  const apply = useCallback(async () => {
    if (!draft || busy) return;
    setBusy(true);
    try {
      const selection = selectionOf(draft);
      const plan = previewPlan(selection);
      const receipt = buildConsentReceipt(
        plan,
        catalog,
        capabilitySetupSeams.now(),
      );
      const result = await compositionStore.commit(selection, receipt);
      setOutcome(viewOutcome(result, snapshot.durability));
    } catch (caught) {
      setOutcome({
        status: "refused",
        message: caught instanceof Error ? caught.message : "not applied",
      });
    } finally {
      setBusy(false);
      setStage("outcome");
    }
  }, [busy, catalog, draft, selectionOf, snapshot.durability]);

  return {
    snapshot,
    catalog,
    managed,
    requiredNotAccepted,
    stage,
    draft,
    review,
    outcome,
    busy,
    roads,
    accept,
    edit,
    apply,
    cancel,
    alternatives: (root: CapabilityId) =>
      alternativesFor(root, catalog, snapshot.plan),
  };
}

export type CapabilitySetupModel = ReturnType<typeof useCapabilitySetup>;
