/**
 * The composition seam.
 *
 * Every capability surface — the setup tab, Settings › Capabilities, the
 * front-door requirements panel, the configuration editor — reaches the
 * store, the registrar, the inventory and the pure semantics through this
 * one module, and nothing else. Its hooks (`bindings/capabilities.ts`) read
 * the store and the contributions through it too. Surfaces read it through
 * `capabilityPorts` at call time, and a test installs the double from
 * `lib/configuration/doubles/` there (`installDoublePorts`), so a surface's
 * suite never depends on the loader landing first and never touches a real
 * store. The owners' exact names are re-exported too (ownership.md §4.1,
 * §4.2, §7); this file adds no behaviour.
 */

import type {
  CapabilityCatalog,
  CapabilityId,
  ContributionKind,
  EffectivePlan,
  InstallationCapabilitySelection,
  InstanceCapabilityPolicy,
  NetworkPolicy,
} from "@opensesame/capability-composition";
import {
  type BoundaryValue,
  isString,
  overlapCast,
} from "@opensesame/os-domain";
import {
  type Preset,
  presetToInstancePolicy as projectPreset,
} from "../capabilities/presets.js";
import { contributions, subscribeRegistry } from "../capabilities/registry.js";
import type { ContributionEntry } from "../capabilities/runtime-contract.js";
import type { CommitOutcome } from "../capabilities/store-types.js";
import { compositionStore } from "../capabilities/store.js";

export { compositionStore } from "../capabilities/store.js";

/**
 * The registry's contributions as the surfaces read them: `version` is a
 * cheap, reference-stable token that moves when `read` would answer
 * differently.
 */
export const contributionSource = {
  subscribe: subscribeRegistry,
  version: <K extends ContributionKind>(kind: K) => contributions(kind),
  read: <K extends ContributionKind>(kind: K) => contributions(kind),
};
export type {
  CommitOutcome,
  CompositionSnapshot,
  EmergencyDisableOutcome,
} from "../capabilities/store-types.js";
export { CAPABILITY_CATALOG } from "../capabilities/catalog.js";
export { PRESETS } from "../capabilities/presets.js";
export {
  buildConsentReceipt,
  canonicalize,
  explainCapability,
  parseInstallationSelection,
  parseInstancePolicy,
  parseVaultSelection,
} from "@opensesame/capability-composition";
import {
  buildConsentReceipt,
  canonicalize,
  explainCapability,
  parseInstallationSelection,
  parseInstancePolicy,
  parseVaultSelection,
} from "@opensesame/capability-composition";
import { CAPABILITY_CATALOG as REAL_CATALOG } from "../capabilities/catalog.js";
import { PRESETS as REAL_PRESETS } from "../capabilities/presets.js";

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

/** `presets.ts`'s projection, taking the structural preset every surface holds. */
export function presetToInstancePolicy(
  preset: CapabilityPreset,
  instanceId: string,
  revision: string,
): InstanceCapabilityPolicy {
  const typed: Preset = overlapCast(preset);
  return projectPreset(typed, instanceId, revision);
}

/**
 * The plan a draft would resolve to, without committing it. `review(draft)`
 * answers with identities and deltas only; the consent receipt binds the
 * after-plan's exposure digests, so the store has to lend it out
 * (`compositionStore.preview`, requested of S06 in the S09 report).
 */
export function previewPlan(
  draft: InstallationCapabilitySelection,
): EffectivePlan {
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
  if (record.status === "conflict")
    return { status: "conflict", message: reason };
  return { status: "refused", message: reason };
}

/**
 * The store as a surface uses it — the methods, not the class, so a test
 * double with the same methods can stand in.
 */
export type CompositionStorePort = Pick<
  typeof compositionStore,
  "getSnapshot" | "subscribe" | "review" | "preview" | "commit" | "invalidate"
>;

/** The registry's contributions as a surface reads them. */
export type ContributionSourcePort = {
  subscribe: (listener: () => void) => () => void;
  /** A reference-stable token that moves when `read` would answer differently. */
  version: (kind: ContributionKind) => object;
  read: <K extends ContributionKind>(
    kind: K,
  ) => readonly ContributionEntry<K>[];
};

/**
 * Everything a capability surface reads from the composition, as one record
 * surfaces read at call time (`capabilityPorts.X`), never at import. A test
 * installs the double here (`installCapabilityPorts`) instead of replacing
 * this module, and restores the real one after.
 */
export type CapabilityPorts = {
  compositionStore: CompositionStorePort;
  contributionSource: ContributionSourcePort;
  CAPABILITY_CATALOG: CapabilityCatalog;
  PRESETS: readonly CapabilityPreset[];
  presetToInstancePolicy: typeof presetToInstancePolicy;
  buildConsentReceipt: typeof buildConsentReceipt;
  canonicalize: typeof canonicalize;
  explainCapability: typeof explainCapability;
  parseInstancePolicy: typeof parseInstancePolicy;
  parseInstallationSelection: typeof parseInstallationSelection;
  parseVaultSelection: typeof parseVaultSelection;
  previewPlan: typeof previewPlan;
  PUBLICATION_CAPABILITIES: readonly CapabilityId[];
  viewOutcome: typeof viewOutcome;
};

const REAL_PORTS: CapabilityPorts = {
  compositionStore,
  contributionSource,
  CAPABILITY_CATALOG: REAL_CATALOG,
  PRESETS: REAL_PRESETS,
  presetToInstancePolicy,
  buildConsentReceipt,
  canonicalize,
  explainCapability,
  parseInstancePolicy,
  parseInstallationSelection,
  parseVaultSelection,
  previewPlan,
  PUBLICATION_CAPABILITIES,
  viewOutcome,
};

export const capabilityPorts: CapabilityPorts = { ...REAL_PORTS };

/** Put a stand-in behind every surface; `restoreCapabilityPorts` undoes it. */
export function installCapabilityPorts(ports: CapabilityPorts): void {
  Object.assign(capabilityPorts, ports);
}

export function restoreCapabilityPorts(): void {
  Object.assign(capabilityPorts, REAL_PORTS);
}
