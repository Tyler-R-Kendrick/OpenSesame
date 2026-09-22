/**
 * The draft — what a person is composing, before anything is committed.
 *
 * Pure data. A preset choice, the optional roots toggled on, the alternative
 * chosen for each slot, and the required roots explicitly accepted. Nothing
 * here touches the store, a module or the network (CONSENT-01): a draft is
 * a preview until `draftToSelection` turns it into the document the store
 * reviews and, on Apply, commits.
 */

import type {
  CapabilityCatalog,
  CapabilityId,
  EffectivePlan,
  InstallationCapabilitySelection,
} from "@opensesame/capability-composition";
import type {
  CapabilityPreset,
  CompositionSnapshot,
} from "../../lib/configuration/capabilities-ports.js";

/** How the person came in — each a choice object on the entry screen. */
export type CapabilityRoad = "minimal" | "customize" | "join";

export type CapabilityDraft = Readonly<{
  road: CapabilityRoad | null;
  preset: string | null;
  roots: readonly CapabilityId[];
  alternatives: Readonly<Record<string, CapabilityId>>;
  acceptedRequired: readonly CapabilityId[];
}>;

export const EMPTY_DRAFT: CapabilityDraft = {
  road: null,
  preset: null,
  roots: [],
  alternatives: {},
  acceptedRequired: [],
};

/** Start from what the installation already has, so a review reads as a diff. */
export function draftFromSelection(
  selection: InstallationCapabilitySelection | null,
  road: CapabilityRoad,
): CapabilityDraft {
  if (!selection) return { ...EMPTY_DRAFT, road };
  return {
    road,
    preset: null,
    roots: [...selection.selectedOptional],
    alternatives: { ...selection.chosenAlternatives },
    acceptedRequired: [...selection.acceptedRequired],
  };
}

/** The minimal configuration: no optional root at all. */
export function minimalDraft(): CapabilityDraft {
  return { ...EMPTY_DRAFT, road: "minimal" };
}

function permitted(plan: EffectivePlan | null, id: CapabilityId): boolean {
  const state = plan?.capabilities[id];
  return state ? state.permitted && state.distributed : true;
}

/**
 * Choosing a purpose is a preview: the preset's default roots become the
 * draft's roots, filtered to what this plan permits and distributes, and its
 * required roots are what the person will be accepting. Nothing is applied.
 */
export function applyPreset(
  draft: CapabilityDraft,
  preset: CapabilityPreset,
  plan: EffectivePlan | null,
): CapabilityDraft {
  return {
    ...draft,
    preset: preset.id,
    roots: preset.defaultSelected.filter((id) => permitted(plan, id)),
    acceptedRequired: preset.required.filter((id) => permitted(plan, id)),
  };
}

export function toggleRoot(draft: CapabilityDraft, id: CapabilityId): CapabilityDraft {
  const on = draft.roots.includes(id);
  return {
    ...draft,
    roots: on ? draft.roots.filter((item) => item !== id) : [...draft.roots, id],
  };
}

export function chooseAlternative(
  draft: CapabilityDraft,
  slot: string,
  id: CapabilityId,
): CapabilityDraft {
  return { ...draft, alternatives: { ...draft.alternatives, [slot]: id } };
}

/** Swap a conflicted root for the alternative the review offered. */
export function replaceRoot(
  draft: CapabilityDraft,
  from: CapabilityId,
  to: CapabilityId,
  catalog: CapabilityCatalog,
): CapabilityDraft {
  const roots = draft.roots.filter((item) => item !== from);
  const optional = catalog.capabilities.some(
    (entry) => entry.id === to && entry.tier === "optional",
  );
  return {
    ...draft,
    roots: optional && !roots.includes(to) ? [...roots, to] : roots,
  };
}

/** Explicit acceptance of a managed instance's required roots (MODEL-10). */
export function acceptRequired(
  draft: CapabilityDraft,
  required: readonly CapabilityId[],
): CapabilityDraft {
  return { ...draft, road: "join", acceptedRequired: [...required] };
}

/** Declining leaves the local path: nothing enabled, nothing deleted. */
export function declineRequired(draft: CapabilityDraft): CapabilityDraft {
  return { ...draft, roots: [], acceptedRequired: [] };
}

export type SelectionBase = Readonly<{
  instanceId: string;
  installationId: string;
  basePolicyRevision: string;
  revision: string;
}>;

export function baseFromSnapshot(
  snapshot: CompositionSnapshot,
  now: string,
): SelectionBase {
  return {
    instanceId: snapshot.plan?.identity.instanceId ?? snapshot.policy?.instanceId ?? "personal-local",
    installationId: snapshot.plan?.identity.installationId ?? "",
    basePolicyRevision: snapshot.policy?.revision ?? "0",
    revision: `draft-${now}`,
  };
}

/** The document the store reviews and commits. Explicit empties, never inherit. */
export function draftToSelection(
  draft: CapabilityDraft,
  base: SelectionBase,
): InstallationCapabilitySelection {
  return {
    schemaVersion: 1,
    kind: "InstallationCapabilitySelection",
    instanceId: base.instanceId,
    installationId: base.installationId,
    basePolicyRevision: base.basePolicyRevision,
    revision: base.revision,
    acceptedRequired: [...draft.acceptedRequired].sort(),
    selectedOptional: [...new Set(draft.roots)].sort(),
    chosenAlternatives: { ...draft.alternatives },
    delivery: { prefetch: "none", offlineCache: "shell-only" },
  };
}

/** Peers in the same family that this plan could run instead of a conflicted root. */
export function alternativesFor(
  root: CapabilityId,
  catalog: CapabilityCatalog,
  plan: EffectivePlan | null,
): readonly CapabilityId[] {
  const family = root.split(".")[0];
  return catalog.capabilities
    .filter((entry) => entry.id !== root && entry.id.split(".")[0] === family)
    .filter((entry) => entry.tier === "core" || permitted(plan, entry.id))
    .filter((entry) => !plan?.conflicts.some((conflict) => conflict.capability === entry.id))
    .map((entry) => entry.id);
}
