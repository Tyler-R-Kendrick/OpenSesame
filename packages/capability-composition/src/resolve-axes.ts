/**
 * The per-capability axes that do not depend on the closure: what the
 * distribution carries, what the policy ceiling and workspace permit, what
 * the vault disabled, what the runtime supports, what the network allows,
 * and whether a worker variant exists for the capability's constraint.
 *
 * `blocked` collects every reason that makes a capability ineligible for any
 * closure. Selection and consent are decided later, on top of these.
 */
import { indexCatalog } from "./catalog.js";
import { applicableReceipt } from "./consent.js";
import { sortIds } from "./ids.js";
import { sortReasons } from "./reasons.js";
import type { ResolveInput } from "./resolve-input.js";
import type {
  CapabilityDescriptor,
  CapabilityId,
  CapabilityTier,
  ConsentReceipt,
  InstallationCapabilitySelection,
  ModuleId,
  NetworkPolicy,
  ReasonCode,
} from "./types.js";

export const PERSONAL_LOCAL_INSTANCE = "personal-local";
export const PERSONAL_LOCAL_REVISION = "personal-local";
export const NO_SELECTION_REVISION = "unselected";

export const PERSONAL_LOCAL_NETWORK: NetworkPolicy = {
  externalServices: "allow",
  allowedServiceOrigins: [],
};
const DENY_ALL_NETWORK: NetworkPolicy = {
  externalServices: "deny",
  allowedServiceOrigins: [],
};

/** Everything the resolver derives once from its input before looking at capabilities. */
export type ResolveContext = Readonly<{
  input: ResolveInput;
  index: ReadonlyMap<CapabilityId, CapabilityDescriptor>;
  ids: readonly CapabilityId[];
  instanceId: string;
  policyRevision: string;
  selectionRevision: string;
  installation: InstallationCapabilitySelection | null;
  profileMismatch: boolean;
  workspaceMismatch: boolean;
  receipt: ConsentReceipt | null;
  network: NetworkPolicy;
  distributed: ReadonlySet<CapabilityId>;
  distributedModules: ReadonlySet<ModuleId>;
  vaultDisabled: ReadonlySet<CapabilityId>;
  required: ReadonlySet<CapabilityId>;
  accepted: ReadonlySet<CapabilityId>;
  selectedRoots: readonly CapabilityId[];
  requiredNotAccepted: readonly CapabilityId[];
  evaluatedModules: ReadonlySet<ModuleId>;
}>;

export function buildContext(input: ResolveInput): ResolveContext {
  const policy = input.instancePolicy;
  const instanceId =
    policy?.instanceId ?? input.installation?.instanceId ?? PERSONAL_LOCAL_INSTANCE;
  const installationMatches =
    input.installation !== null &&
    input.installation.instanceId === instanceId &&
    input.installation.installationId === input.installationId;
  const installation = installationMatches ? input.installation : null;
  const workspace = input.workspace;
  const workspaceMismatch =
    workspace !== null &&
    (workspace.instanceId !== instanceId || workspace.vaultId !== input.vaultId);
  const required = new Set(policy === null || !input.policyValid ? [] : policy.capabilities.required);
  const accepted = new Set(installation === null ? [] : installation.acceptedRequired);
  const network = policy === null ? PERSONAL_LOCAL_NETWORK : input.policyValid ? policy.network : DENY_ALL_NETWORK;
  return {
    input,
    index: indexCatalog(input.catalog),
    ids: sortIds(input.catalog.capabilities.map((d) => d.id)),
    instanceId,
    policyRevision: policy?.revision ?? PERSONAL_LOCAL_REVISION,
    selectionRevision: installation?.revision ?? NO_SELECTION_REVISION,
    installation,
    profileMismatch: input.installation !== null && !installationMatches,
    workspaceMismatch,
    receipt: applicableReceipt(input.receipt, instanceId, input.installationId),
    network,
    distributed: new Set(input.distribution.capabilityIds),
    distributedModules: new Set(input.distribution.moduleIds),
    vaultDisabled: new Set(input.vault === null ? [] : input.vault.disabled),
    required,
    accepted,
    selectedRoots: installation === null ? [] : sortIds([...installation.acceptedRequired, ...installation.selectedOptional]),
    requiredNotAccepted: sortIds([...required].filter((id) => !accepted.has(id))),
    evaluatedModules: new Set(input.facts.evaluatedModuleIds),
  };
}

export type Axis = Readonly<{
  id: CapabilityId;
  tier: CapabilityTier;
  distributed: boolean;
  permitted: boolean;
  required: boolean;
  selected: boolean;
  runtimeSupported: boolean;
  /** Sorted; an optional capability is eligible for a closure iff empty. */
  blocked: readonly ReasonCode[];
}>;

function runtimeSupports(ctx: ResolveContext, d: CapabilityDescriptor): boolean {
  const hosts = new Set(ctx.input.facts.environments);
  if (!d.environments.every((e) => hosts.has(e))) return false;
  if (d.environments.includes("service-worker") && !ctx.input.facts.serviceWorkerAvailable) {
    return false;
  }
  return true;
}

function workerVariantExists(ctx: ResolveContext, constraint: string): boolean {
  if (!ctx.input.facts.serviceWorkerAvailable) return false;
  return ctx.input.distribution.workerVariants.some((v) => v.satisfies.includes(constraint));
}

export function hasAutomaticExternalEgress(d: CapabilityDescriptor): boolean {
  return d.egress.some((e) => e.class === "external-service" && e.automatic);
}

function policyReasons(ctx: ResolveContext, id: CapabilityId): ReasonCode[] {
  const policy = ctx.input.instancePolicy;
  const out: ReasonCode[] = [];
  if (!ctx.input.policyValid) out.push("POLICY_UNVERIFIED");
  if (ctx.profileMismatch || ctx.workspaceMismatch) out.push("PROFILE_MISMATCH");
  if (policy !== null && ctx.input.policyValid) {
    const caps = policy.capabilities;
    if (caps.prohibited.includes(id)) out.push("PROHIBITED_BY_INSTANCE");
    else if (!caps.required.includes(id) && !caps.optional.includes(id)) {
      out.push("NOT_PERMITTED_BY_INSTANCE");
    }
  }
  const workspace = ctx.input.workspace;
  if (workspace !== null) {
    const denied =
      ctx.workspaceMismatch ||
      workspace.prohibited.includes(id) ||
      (workspace.allow !== null && !workspace.allow.includes(id));
    if (denied) out.push("DENIED_BY_WORKSPACE");
  }
  return out;
}

const PERMISSION_REASONS: ReadonlySet<ReasonCode> = new Set<ReasonCode>([
  "POLICY_UNVERIFIED",
  "PROFILE_MISMATCH",
  "PROHIBITED_BY_INSTANCE",
  "NOT_PERMITTED_BY_INSTANCE",
  "DENIED_BY_WORKSPACE",
]);

function optionalAxis(ctx: ResolveContext, d: CapabilityDescriptor): Axis {
  const distributed = ctx.distributed.has(d.id);
  const runtimeSupported = runtimeSupports(ctx, d);
  const blocked: ReasonCode[] = policyReasons(ctx, d.id);
  if (!distributed) blocked.push("NOT_DISTRIBUTED");
  if (ctx.vaultDisabled.has(d.id)) blocked.push("DISABLED_IN_VAULT");
  if (!runtimeSupported) blocked.push("UNSUPPORTED_RUNTIME");
  if (hasAutomaticExternalEgress(d) && ctx.network.externalServices === "deny") {
    blocked.push("NETWORK_POLICY_DENIES");
  }
  if (d.workerGraphConstraint !== null && !workerVariantExists(ctx, d.workerGraphConstraint)) {
    blocked.push("WORKER_GRAPH_UNAVAILABLE");
  }
  return {
    id: d.id,
    tier: "optional",
    distributed,
    permitted: distributed && !blocked.some((r) => PERMISSION_REASONS.has(r)),
    required: ctx.required.has(d.id),
    selected: ctx.selectedRoots.includes(d.id),
    runtimeSupported,
    blocked: sortReasons(blocked),
  };
}

function coreAxis(ctx: ResolveContext, d: CapabilityDescriptor): Axis {
  return {
    id: d.id,
    tier: "core",
    distributed: true,
    permitted: true,
    required: false,
    selected: true,
    runtimeSupported: runtimeSupports(ctx, d),
    blocked: [],
  };
}

export function computeAxes(ctx: ResolveContext): ReadonlyMap<CapabilityId, Axis> {
  const axes = new Map<CapabilityId, Axis>();
  for (const id of ctx.ids) {
    const d = ctx.index.get(id);
    if (d === undefined) continue;
    axes.set(id, d.tier === "core" ? coreAxis(ctx, d) : optionalAxis(ctx, d));
  }
  return axes;
}

/** A copy of the axes with one more blocking reason on the named capabilities. */
export function blockAxes(
  axes: ReadonlyMap<CapabilityId, Axis>,
  ids: ReadonlySet<CapabilityId>,
  reason: ReasonCode,
): ReadonlyMap<CapabilityId, Axis> {
  const out = new Map(axes);
  for (const id of ids) {
    const axis = axes.get(id);
    if (axis === undefined || axis.tier === "core") continue;
    out.set(id, { ...axis, blocked: sortReasons([...axis.blocked, reason]) });
  }
  return out;
}
