/**
 * The setup tab's state machine: roads → purpose → cards → review → apply.
 *
 * Every transition before Apply is pure draft state. Apply is the only call
 * that reaches the store's `commit`, and it goes with the receipt built from
 * the reviewed plan (CONSENT-03). Cancel drops the draft and nothing else
 * (CONSENT-02).
 */

import {
  type CapabilityPreset,
  type CompositionSnapshot,
  type OutcomeView,
  capabilityPorts,
} from "@opensesame/app-core/lib/configuration/capabilities-ports.js";
import type {
  CapabilityCatalog,
  CapabilityId,
  CompositionChangeReview,
  EffectivePlan,
  InstallationCapabilitySelection,
} from "@opensesame/capability-composition";
import {
  type Dispatch,
  type SetStateAction,
  useCallback,
  useMemo,
  useState,
} from "react";
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

import { useComposition } from "../../bindings/capabilities.js";
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

type DraftEditorArgs = Readonly<{
  draft: CapabilityDraft | null;
  setDraft: Dispatch<SetStateAction<CapabilityDraft | null>>;
  setStage: Dispatch<SetStateAction<SetupStage>>;
  openReview: (next: CapabilityDraft) => void;
  catalog: CapabilityCatalog;
  plan: EffectivePlan | null;
}>;

/**
 * Every edit is a pure transform of the draft. `replace` and `review` are
 * the only two that open the review, and neither commits anything.
 */
function useDraftEditors(args: DraftEditorArgs): DraftEditors {
  const { draft, setDraft, setStage, openReview, catalog, plan } = args;
  return useMemo(
    () => ({
      preset: (preset: CapabilityPreset) => {
        setDraft((current) =>
          applyPreset(
            current ?? draftFromSelection(null, "customize"),
            preset,
            plan,
          ),
        );
        setStage("cards");
      },
      toggle: (id: CapabilityId) =>
        setDraft((current) => (current ? toggleRoot(current, id) : current)),
      alternative: (slot: string, id: CapabilityId) =>
        setDraft((current) =>
          current ? chooseAlternative(current, slot, id) : current,
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

type RoadArgs = Readonly<{
  selection: InstallationCapabilitySelection | null;
  requiredNotAccepted: readonly CapabilityId[];
  managed: boolean;
  setDraft: Dispatch<SetStateAction<CapabilityDraft | null>>;
  setStage: Dispatch<SetStateAction<SetupStage>>;
  openReview: (next: CapabilityDraft) => void;
}>;

/**
 * The three roads in, and the explicit yes that follows the join road. Each
 * is a choice object on the entry screen and none of them commits: minimal
 * goes straight to the review, customize opens the cards, join opens the
 * requirements panel (MODEL-10).
 */
function useRoads(args: RoadArgs) {
  const { selection, requiredNotAccepted, managed } = args;
  const { setDraft, setStage, openReview } = args;
  const roads = useMemo(
    () => ({
      minimal: () => openReview(minimalDraft()),
      customize: () => {
        setDraft(draftFromSelection(selection, "customize"));
        setStage(managed ? "cards" : "purpose");
      },
      join: () => setStage("join"),
    }),
    [managed, openReview, selection, setDraft, setStage],
  );
  const accept = useCallback(() => {
    setDraft(
      acceptRequired(
        draftFromSelection(selection, "join"),
        requiredNotAccepted,
      ),
    );
    setStage("cards");
  }, [requiredNotAccepted, selection, setDraft, setStage]);
  return { roads, accept };
}

type ApplyArgs = Readonly<{
  draft: CapabilityDraft | null;
  busy: boolean;
  setBusy: Dispatch<SetStateAction<boolean>>;
  setOutcome: Dispatch<SetStateAction<OutcomeView | null>>;
  setStage: Dispatch<SetStateAction<SetupStage>>;
  selectionOf: (next: CapabilityDraft) => InstallationCapabilitySelection;
  catalog: CapabilityCatalog;
  durability: CompositionSnapshot["durability"];
}>;

/**
 * The one path that reaches the store. It previews the selection, binds a
 * receipt to that plan, commits, and only then reports durable, session-only,
 * conflict or refused — never before the store has answered (CONSENT-03).
 */
function useApply(args: ApplyArgs): () => Promise<void> {
  const { draft, busy, setBusy, setOutcome, setStage } = args;
  const { selectionOf, catalog, durability } = args;
  return useCallback(async () => {
    if (!draft || busy) return;
    setBusy(true);
    try {
      const selection = selectionOf(draft);
      const receipt = capabilityPorts.buildConsentReceipt(
        capabilityPorts.previewPlan(selection),
        catalog,
        capabilitySetupSeams.now(),
      );
      const result = await capabilityPorts.compositionStore.commit(
        selection,
        receipt,
      );
      setOutcome(capabilityPorts.viewOutcome(result, durability));
    } catch (caught) {
      setOutcome({
        status: "refused",
        message: caught instanceof Error ? caught.message : "not applied",
      });
    } finally {
      setBusy(false);
      setStage("outcome");
    }
  }, [
    busy,
    catalog,
    draft,
    durability,
    selectionOf,
    setBusy,
    setOutcome,
    setStage,
  ]);
}

export function useCapabilitySetup(initialJoin: boolean) {
  const snapshot = useComposition();
  const catalog = capabilityPorts.CAPABILITY_CATALOG;
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
      setReview(capabilityPorts.compositionStore.review(selectionOf(next)));
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

  const { roads, accept } = useRoads({
    selection: snapshot.selection,
    requiredNotAccepted,
    managed,
    setDraft,
    setStage,
    openReview,
  });

  const edit = useDraftEditors({
    draft,
    setDraft,
    setStage,
    openReview,
    catalog,
    plan: snapshot.plan,
  });

  const apply = useApply({
    draft,
    busy,
    setBusy,
    setOutcome,
    setStage,
    selectionOf,
    catalog,
    durability: snapshot.durability,
  });

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
