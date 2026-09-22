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
import { type CommitOutcome, compositionStore } from "../capabilities/store.js";

export {
  compositionStore,
  useCapability,
  useComposition,
} from "../capabilities/store.js";
export type {
  CommitOutcome,
  CompositionSnapshot,
  EmergencyDisableOutcome,
} from "../capabilities/store.js";
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
export function previewPlan(draft: InstallationCapabilitySelection): EffectivePlan {
  return compositionStore.preview(draft);
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

const OUTCOMES: readonly OutcomeStatus[] = [
  "durable",
  "session-only",
  "conflict",
  "refused",
];

/**
 * Read a store outcome without depending on its exact shape: `status` is
 * one of the four words above, `message` is optional prose. Anything else
 * reads as refused — a commit whose result cannot be read was not confirmed.
 */
export function viewOutcome(outcome: CommitOutcome | BoundaryValue): OutcomeView {
  const record: { status?: BoundaryValue; message?: BoundaryValue } =
    overlapCast(outcome ?? {});
  const status = OUTCOMES.find((item) => item === record.status) ?? "refused";
  return {
    status,
    message: isString(record.message) ? record.message : "",
  };
}
