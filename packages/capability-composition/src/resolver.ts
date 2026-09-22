/**
 * The pure resolver: documents + distribution inventory + environmental facts
 * → an immutable EffectivePlan. No I/O, no clock, no randomness — `evaluatedAt`
 * is passed in by the caller and everything is sorted canonically before the
 * digest so the output is identical for any input ordering.
 *
 * Resolution rules (normative):
 * - prohibited wins over everything: a prohibited id anywhere in the closure
 *   rejects that id and everything that depends on it;
 * - the closure (required ∪ selected ∪ closure-reached deps) must sit inside
 *   distribution ∩ permitted-ceiling; a dependency outside is a
 *   DEPENDENCY_CONFLICT — dependencies are never auto-enabled;
 * - unknown ids (not in the distribution and not descriptors) are UNKNOWN
 *   conflicts with a diagnostic, never silently dropped;
 * - narrowing the permitted set can never enlarge the loadable set;
 * - cycles in the dependency graph are conflicts, not hangs.
 */
import type { BoundaryValue } from "@opensesame/os-domain";
import type {
  CapabilityDescriptor,
  ExecutionEnvironment,
} from "./descriptor.js";
import { validateDescriptor } from "./descriptor.js";
import { digestCanonical } from "./digest.js";
import {
  type DocumentValidationFailure,
  type InstallationSelectionDocument,
  type InstancePolicyDocument,
  type VaultRestrictionDocument,
  validateInstallationSelection,
  validateInstancePolicy,
  validateVaultRestriction,
} from "./documents.js";
import type { ReasonCode } from "./ids.js";
import type { Ceiling, Node } from "./resolver-graph.js";
import {
  collect,
  compareStrings,
  idsOf,
  markBlockedFor,
  markProhibited,
  permittedCeiling,
  sortConflicts,
  union,
} from "./resolver-graph.js";
import { evaluateNode } from "./resolver-node.js";

export type DistributionInventory = {
  readonly distributionId: string;
  /** Descriptor payloads shipped in THIS build (each validated as a descriptor). */
  readonly descriptors: readonly BoundaryValue[];
  /** Module ids shipped in THIS build. */
  readonly moduleIds: readonly string[];
  /** Capability ids with pre-cached offline assets on this device. */
  readonly cachedCapabilityIds: readonly string[];
};

export type ResolverInput = {
  readonly distribution: DistributionInventory;
  readonly instancePolicy: BoundaryValue;
  readonly vaultRestriction?: BoundaryValue;
  readonly installationSelection?: BoundaryValue;
  /** Explicit environmental facts; never discovered here. */
  readonly runtimeEnvironments: readonly ExecutionEnvironment[];
  /** Caller-supplied ISO timestamp; the resolver has no clock. */
  readonly evaluatedAt: string;
  /**
   * Consent state per capability id (operator/user granted). Absent = not
   * consented. Only capabilities whose descriptor demands consent look here.
   */
  readonly consentedCapabilityIds?: readonly string[];
};

export type StateAxes = {
  readonly permitted: boolean;
  readonly selected: boolean;
  readonly availableInDistribution: boolean;
  readonly supportedByRuntime: boolean;
  readonly consented: boolean;
  readonly loaded: boolean;
};

export type ActivationStatus =
  | "not-shipped"
  | "not-selected"
  | "not-loaded"
  | "disabled"
  | "cached"
  | "active"
  | "restart-required";

export type PlanConflict = {
  readonly reasonCode: ReasonCode;
  readonly capabilityId: string;
  readonly detail: string;
  /** Which document/scope produced the blocking fact. */
  readonly provenance: string;
};

export type ConsentDelta = {
  readonly capabilityId: string;
  readonly required: boolean;
  readonly granted: boolean;
};

export type SelectedCapability = {
  readonly id: string;
  readonly descriptorVersion: number;
  readonly stateAxes: StateAxes;
  readonly reasonCodes: readonly ReasonCode[];
  readonly conflicts: readonly PlanConflict[];
  readonly activationStatus: ActivationStatus;
  readonly moduleIds: readonly string[];
};

export type PlanIdentity = {
  readonly instanceId: string;
  readonly installationId: string;
  readonly vaultId: string | null;
  readonly distributionId: string;
  readonly policyRevision: number;
  readonly selectionRevision: number;
  readonly planDigest: string;
};

/** Resolve an effective plan. Pure: same input → same output, always. */
export function resolveEffectivePlan(input: ResolverInput): ResolverOutcome {
  const policy = validateInstancePolicy(input.instancePolicy);
  const vault = input.vaultRestriction
    ? validateVaultRestriction(input.vaultRestriction)
    : undefined;
  const selection = input.installationSelection
    ? validateInstallationSelection(input.installationSelection)
    : undefined;
  const failures: DocumentValidationFailure[] = [];
  if (!policy.ok) failures.push(...policy.failures);
  if (vault && !vault.ok) failures.push(...vault.failures);
  if (selection && !selection.ok) failures.push(...selection.failures);
  if (failures.length > 0 || !policy.ok) return { ok: false, failures };
  if (vault?.ok === false || selection?.ok === false) {
    return { ok: false, failures };
  }

  const p = policy.document;
  const v = vault?.ok ? vault.document : undefined;
  const s = selection?.ok ? selection.document : undefined;

  // Cross-document coherence: a vault restriction or selection must not
  // bind to a different instance than the policy it narrows.
  const coherence: DocumentValidationFailure[] = [];
  if (v && v.instanceId !== p.instanceId) {
    coherence.push({
      field: "vaultRestriction.instanceId",
      problem: "vault restriction binds a different instance",
    });
  }
  if (s && s.instanceId !== p.instanceId) {
    coherence.push({
      field: "installationSelection.instanceId",
      problem: "selection binds a different instance",
    });
  }
  if (v && s && s.vaultId !== null && s.vaultId !== v.vaultId) {
    coherence.push({
      field: "installationSelection.vaultId",
      problem: "selection and restriction bind different vaults",
    });
  }
  if (coherence.length > 0) return { ok: false, failures: coherence };

  return { ok: true, plan: composePlan(input, p, v, s) };
}

function composePlan(
  input: ResolverInput,
  policy: InstancePolicyDocument,
  vault: VaultRestrictionDocument | undefined,
  selection: InstallationSelectionDocument | undefined,
): EffectivePlan {
  const descriptors = new Map<string, CapabilityDescriptor>();
  const conflicts: PlanConflict[] = [];
  for (const raw of input.distribution.descriptors) {
    const checked = validateDescriptor(raw);
    if (checked.ok) descriptors.set(checked.descriptor.id, checked.descriptor);
    else {
      for (const failure of checked.failures) {
        conflicts.push({
          reasonCode: "UNKNOWN",
          capabilityId: failure.field || "(descriptor)",
          detail: `malformed descriptor: ${failure.problem}`,
          provenance: "distribution",
        });
      }
    }
  }

  const shipped = new Set(descriptors.keys());
  const shippedModules = new Set(input.distribution.moduleIds);
  const cachedSet = new Set(input.distribution.cachedCapabilityIds);
  const consented = new Set(input.consentedCapabilityIds ?? []);
  const runtime = new Set(input.runtimeEnvironments);
  const evaluatedAt = input.evaluatedAt;

  // The permitted ceiling: instance ∩ vault ∩ selection allow-scopes.
  // Only explicit allow sets narrow; "inherit" defers to the parent scope.
  const ceiling = permittedCeiling(policy, vault, selection);
  // Desired set: policy required ∪ selection's explicit choices.
  // A vault allow set is a ceiling only — it never selects on its own,
  // so narrowing it cannot enlarge the loadable set (monotonicity).
  const wanted = union(
    policy.required,
    selection ? [...selection.required, ...idsOf(selection.allow)] : [],
  );
  const optionalWanted = union(
    policy.optional,
    selection ? selection.optional : [],
  );

  // Closure over dependency graph from every wanted root, following the
  // *distribution's* descriptors. Unknown roots are reported, not followed.
  const closure = new Map<string, Node>();
  for (const root of [...wanted, ...optionalWanted]) {
    if (!shipped.has(root)) continue;
    collect(root, descriptors, closure, conflicts);
  }
  for (const root of [...wanted, ...optionalWanted]) {
    if (!shipped.has(root)) {
      conflicts.push({
        // UNKNOWN means "no descriptor anywhere"; a descriptor that exists
        // but is not shipped is NOT_DISTRIBUTED.
        reasonCode: "NOT_DISTRIBUTED",
        capabilityId: root,
        detail: wanted.has(root)
          ? "required capability is not in this distribution"
          : "optional capability is not in this distribution",
        provenance: "distribution",
      });
    }
  }

  // Mark which documents prohibit each closure member (prohibited wins).
  markProhibited(closure, policy, vault, selection);

  const selected: SelectedCapability[] = [];
  const consentDeltas: ConsentDelta[] = [];
  const ids = [...closure.keys()].sort(compareStrings);
  for (const id of ids) {
    const node = closure.get(id);
    if (node === undefined) continue;
    const descriptor = descriptors.get(id);
    if (descriptor === undefined) continue;
    const evaluation = evaluateNode(id, descriptor, node.dependents.size, {
      wanted,
      optionalWanted,
      blockedByDeps: markBlockedFor(id, closure, descriptors),
      prohibitedBy: node.prohibitedBy,
      ceiling,
      shipped,
      shippedModules,
      runtime,
      consented,
      cached: cachedSet,
    });
    selected.push(evaluation.entry);
    conflicts.push(...evaluation.conflicts);
    if (evaluation.delta !== undefined) consentDeltas.push(evaluation.delta);
  }

  const identity = {
    instanceId: policy.instanceId,
    installationId: selection ? selection.installationId : "unselected",
    vaultId: vault ? vault.vaultId : selection ? selection.vaultId : null,
    distributionId: input.distribution.distributionId,
    policyRevision: policy.revision,
    selectionRevision: selection ? selection.revision : 0,
  };
  const planDigest =
    digestCanonical({
      ...identity,
      evaluatedAt,
      selected: selected.map((c) => ({
        id: c.id,
        descriptorVersion: c.descriptorVersion,
        axes: { ...c.stateAxes },
        status: c.activationStatus,
        reasons: [...c.reasonCodes],
      })),
      conflicts: conflicts.map((c) => ({
        id: c.capabilityId,
        reason: c.reasonCode,
        detail: c.detail,
      })),
    }) ?? ZERO_DIGEST;
  return {
    planIdentity: { ...identity, planDigest },
    evaluatedAt,
    selected,
    conflicts: sortConflicts(conflicts),
    consentDeltas,
  };
}

export type EffectivePlan = {
  readonly planIdentity: PlanIdentity;
  readonly evaluatedAt: string;
  readonly selected: readonly SelectedCapability[];
  readonly conflicts: readonly PlanConflict[];
  readonly consentDeltas: readonly ConsentDelta[];
};

export type ResolverOutcome =
  | { readonly ok: true; readonly plan: EffectivePlan }
  | {
      readonly ok: false;
      readonly failures: readonly DocumentValidationFailure[];
    };

const ZERO_DIGEST = "0".repeat(16);
