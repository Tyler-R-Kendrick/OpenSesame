/**
 * The composition seam.
 *
 * Every capability surface — the setup tab, Settings › Capabilities, the
 * front-door requirements panel, the configuration editor — reaches the
 * store, the registrar, the inventory and the pure semantics through this
 * one module, and nothing else. Tests replace it whole (`vi.mock`) with the
 * double in `screens/capabilities/composition-fixture.ts`, so a surface's
 * suite never depends on the loader landing first and never touches a real
 * store. Production code re-exports the owners' exact names
 * (ownership.md §4.1, §4.2, §7); this file adds no behaviour.
 */

import type {
  CapabilityId,
  EffectivePlan,
  InstallationCapabilitySelection,
  NetworkPolicy,
} from "@opensesame/capability-composition";
import { type BoundaryValue, isString, overlapCast } from "@opensesame/os-domain";
import { compositionStore } from "../capabilities/store.js";
import type { CommitOutcome } from "../capabilities/store-types.js";

export {
  compositionStore,
  useCapability,
  useComposition,
} from "../capabilities/store.js";
export type {
  CommitOutcome,
  CompositionSnapshot,
  EmergencyDisableOutcome,
} from "../capabilities/store-types.js";
export { useContributions } from "../capabilities/registry.js";
export { CAPABILITY_CATALOG } from "../capabilities/catalog.js";
export { PRESETS, presetToInstancePolicy } from "../capabilities/presets.js";
export {
  buildConsentReceipt,
  canonicalize,
  explainCapability,
  parseInstallationSelection,
  parseInstancePolicy,
  parseVaultSelection,
} from "@opensesame/capability-composition";

/** A purpose preset as `lib/capabilities/presets.ts` (S02) publishes it. */
export type CapabilityPreset = Readonly<{
  id: string;
  version: number;
  title: string;
  summary: string;
  required: readonly CapabilityId[];
  optional: readonly CapabilityId[];
  defaultSelected: readonly CapabilityId[];
  network: NetworkPolicy;
}>;

/**
 * The plan a draft would resolve to, without committing it. `review(draft)`
 * answers with identities and deltas only; the consent receipt binds the
 * after-plan's exposure digests, so the store has to lend it out
 * (`compositionStore.preview`, requested of S06 in the S09 report).
 */
export function previewPlan(
  draft: InstallationCapabilitySelection,
): EffectivePlan {
  const store: { preview?: (d: InstallationCapabilitySelection) => EffectivePlan } =
    overlapCast(compositionStore);
  if (typeof store.preview !== "function") {
    throw new Error("The composition store cannot preview a draft yet.");
  }
  return store.preview(draft);
}

/**
 * Capabilities whose approval offers "Publish deployment configuration".
 * Absent from the plan, the control is absent — never disabled.
 */
export const PUBLICATION_CAPABILITIES: readonly CapabilityId[] = [
  "backup.git-remote",
];

/** The four outcomes a commit can have, as every surface reports them. */
export type OutcomeStatus = "durable" | "session-only" | "conflict" | "refused";

export type OutcomeView = Readonly<{ status: OutcomeStatus; message: string }>;

/**
 * Read a store outcome (`store-types.ts` `CommitOutcome`) as the four words
 * a person is shown. "committed" is durable or session-only according to
 * where the store could write; a conflict or refusal carries its reason.
 * Anything unreadable is a refusal — a commit whose result cannot be read
 * was not confirmed.
 */
export function viewOutcome(
  outcome: CommitOutcome | BoundaryValue,
  durability: "durable" | "session-only" | "unknown" = "unknown",
): OutcomeView {
  const record: { status?: BoundaryValue; reason?: BoundaryValue } =
    overlapCast(outcome ?? {});
  const reason = isString(record.reason) ? record.reason : "";
  if (record.status === "committed") {
    return {
      status: durability === "session-only" ? "session-only" : "durable",
      message: "",
    };
  }
  if (record.status === "conflict") return { status: "conflict", message: reason };
  return { status: "refused", message: reason };
}
