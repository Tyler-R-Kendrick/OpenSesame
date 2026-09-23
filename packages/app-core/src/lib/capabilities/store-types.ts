/**
 * Snapshot and outcome types for the composition store (ownership.md §4.1),
 * plus the pure projection from a plan to the lifecycle a UI may show.
 */

import type {
  CapabilityId,
  CapabilityLifecycle,
  CapabilityState,
  ConsentReceipt,
  DistributionContract,
  EffectivePlan,
  InstallationCapabilitySelection,
  InstanceCapabilityPolicy,
  PolicyProvenance,
  RuntimeFacts,
} from "@opensesame/capability-composition";
import { type KvDurability, kvDurability } from "../kv.js";
import type { ParsedRuntimeConfig } from "../runtime-config.js";

export type CompositionStatus =
  | "resolving"
  | "ready"
  | "managed-invalid"
  | "storage-unavailable";

export type CompositionDurability = "durable" | "session-only" | "unknown";

export type CompositionSnapshot = Readonly<{
  status: CompositionStatus;
  /** Null until resolved; never a permissive default. */
  plan: EffectivePlan | null;
  /** Bumps on every commit, lock, vault switch and revocation. */
  generation: number;
  provenance: PolicyProvenance;
  policy: InstanceCapabilityPolicy | null;
  selection: InstallationCapabilitySelection | null;
  receipt: ConsentReceipt | null;
  lifecycle: Readonly<Record<CapabilityId, CapabilityLifecycle>>;
  durability: CompositionDurability;
  /** Human-readable, never secrets. */
  diagnostics: readonly string[];
}>;

export type BootInput = Readonly<{
  runtimeConfig: ParsedRuntimeConfig;
  vaultId: string | null;
  facts: RuntimeFacts;
}>;

export type CommitOutcome =
  | Readonly<{
      status: "committed";
      generation: number;
      committedGeneration: number;
    }>
  | Readonly<{
      status: "conflict";
      reason: "selection-revision" | "policy-revision" | "generation";
    }>
  | Readonly<{
      status: "refused";
      reason:
        | "not-ready"
        | "managed-invalid"
        | "no-serialization"
        | "storage"
        | "scope-mismatch"
        | "receipt-mismatch"
        | "consent-incomplete";
    }>;

export type EmergencyDisableOutcome = Readonly<{
  /** Always true: the in-memory plan no longer approves the capability. */
  blockedNow: true;
  /** Whether the per-vault disable also reached durable storage. */
  durable: boolean;
}>;

/** What the loader reports about a capability in this realm. */
export type CapabilityActivity = "loading" | "active";

export const INITIAL_SNAPSHOT: CompositionSnapshot = Object.freeze({
  status: "resolving",
  plan: null,
  generation: 0,
  provenance: "personal-local",
  policy: null,
  selection: null,
  receipt: null,
  lifecycle: Object.freeze({}),
  durability: "unknown",
  diagnostics: Object.freeze([]),
});

export function durabilityOf(
  kv: KvDurability = kvDurability(),
): CompositionDurability {
  if (kv === "persistent") return "durable";
  if (kv === "memory") return "session-only";
  return "unknown";
}

function lifecycleFor(
  state: CapabilityState,
  activity: CapabilityActivity | undefined,
): CapabilityLifecycle {
  if (!state.distributed) return "not-distributed";
  if (state.approved) {
    if (activity === "active") return "active";
    if (activity === "loading") return "loading";
    return "approved-not-loaded";
  }
  if (state.restartRequired) return "disabled-restart-required";
  if (state.reasons.includes("CONSENT_REQUIRED")) return "consent-required";
  if (state.reasons.includes("NOT_SELECTED")) return "not-selected";
  return "disabled";
}

/** One lifecycle claim per catalog capability, none implying another. */
export function lifecycleMap(
  plan: EffectivePlan,
  distribution: DistributionContract,
  activity: ReadonlyMap<CapabilityId, CapabilityActivity>,
): Readonly<Record<CapabilityId, CapabilityLifecycle>> {
  const out: Record<CapabilityId, CapabilityLifecycle> = {};
  const distributed = new Set(distribution.capabilityIds);
  for (const [id, state] of Object.entries(plan.capabilities)) {
    out[id] = distributed.has(id)
      ? lifecycleFor(state, activity.get(id))
      : "not-distributed";
  }
  return out;
}
