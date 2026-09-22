/**
 * Limited-carry selection, removal, and separate-context restoration (UX-D).
 */

import {
  type CompartmentItem,
  type PublishedCompartment,
  createKeyedCompartment,
} from "./registry.js";
import { type ScopedView, projectScopedView } from "./scope.js";
import { mintPresentationSession, openPresentation } from "./session.js";

export type LimitedCarryPlan = Readonly<{
  sourceItemIds: readonly string[];
  carryCompartmentRef: string;
  restoreContextId: string;
  /** Explicit pre-incident owner consent timestamp. */
  consentedAt: string;
  removeFromSource: boolean;
  exposurePreview: Readonly<{
    carriedTitles: readonly string[];
    historicalCopyDisclosure: true;
    knownCopyLimitations: readonly string[];
  }>;
}>;

export type LimitedCarryBundle = Readonly<{
  plan: LimitedCarryPlan;
  published: PublishedCompartment;
  rawKey: Uint8Array;
  /** Items remaining in source after optional removal. */
  sourceRemaining: readonly CompartmentItem[];
}>;

export function previewLimitedCarryExposure(
  sourceItems: readonly CompartmentItem[],
  itemIds: readonly string[],
): LimitedCarryPlan["exposurePreview"] {
  const allow = new Set(itemIds);
  const chosen = sourceItems.filter((i) => allow.has(i.id));
  return {
    carriedTitles: chosen.map((i) => i.title),
    historicalCopyDisclosure: true,
    knownCopyLimitations: [
      "Prior offline copies of source items remain decryptable with historical keys.",
      "Limited-carry is a separate independently keyed compartment, not shared-root isolation.",
      "Restoration requires a distinct session context id.",
    ],
  };
}

export function buildLimitedCarryPlan(input: {
  sourceItems: readonly CompartmentItem[];
  itemIds: readonly string[];
  carryCompartmentRef: string;
  restoreContextId: string;
  removeFromSource: boolean;
  at?: Date;
}): LimitedCarryPlan {
  const allow = new Set(input.itemIds);
  const chosen = input.sourceItems.filter((i) => allow.has(i.id));
  if (chosen.length !== input.itemIds.length) {
    throw new Error("limited_carry_unknown_item");
  }
  if (chosen.length === 0) {
    throw new Error("limited_carry_empty");
  }
  return {
    sourceItemIds: chosen.map((i) => i.id),
    carryCompartmentRef: input.carryCompartmentRef,
    restoreContextId: input.restoreContextId,
    consentedAt: (input.at ?? new Date()).toISOString(),
    removeFromSource: input.removeFromSource,
    exposurePreview: previewLimitedCarryExposure(
      input.sourceItems,
      input.itemIds,
    ),
  };
}

export async function materializeLimitedCarry(input: {
  plan: LimitedCarryPlan;
  sourceItems: readonly CompartmentItem[];
  keyEpoch: number;
}): Promise<LimitedCarryBundle> {
  const allow = new Set(input.plan.sourceItemIds);
  const carried = input.sourceItems.filter((i) => allow.has(i.id));
  const published = await createKeyedCompartment({
    compartmentRef: input.plan.carryCompartmentRef,
    kind: "limited_carry",
    label: "Limited carry",
    items: carried,
    keyEpoch: input.keyEpoch,
  });
  const sourceRemaining = input.plan.removeFromSource
    ? input.sourceItems.filter((i) => !allow.has(i.id))
    : [...input.sourceItems];
  return {
    plan: input.plan,
    published,
    rawKey: published.rawKey,
    sourceRemaining,
  };
}

/**
 * Restoration opens the carry compartment in a *separate* context — never merges
 * into the active duress/protected session silently.
 */
export async function restoreLimitedCarryOffline(input: {
  bundle: LimitedCarryBundle;
  activeContextId: string;
  restoreContextId: string;
}): Promise<
  | { ok: true; view: ScopedView }
  | { ok: false; code: "same_context" | "context_mismatch" | "locked" }
> {
  if (input.restoreContextId === input.activeContextId) {
    return { ok: false, code: "same_context" };
  }
  if (input.restoreContextId !== input.bundle.plan.restoreContextId) {
    return { ok: false, code: "context_mismatch" };
  }
  const session = await mintPresentationSession({
    presentation: "restricted",
    profileId: "limited-carry-restore",
    contextId: input.restoreContextId,
    admittedKeys: [
      {
        compartmentRef: input.bundle.published.compartmentRef,
        keyEpoch: input.bundle.published.keyEpoch,
        rawKey: input.bundle.rawKey,
      },
    ],
  });
  const outcome = await openPresentation(session, input.bundle.published, {
    expectKind: "limited_carry",
  });
  if (outcome.kind === "locked") {
    return { ok: false, code: "locked" };
  }
  return { ok: true, view: projectScopedView(outcome) };
}
