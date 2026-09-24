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
import { withdrawnCore } from "./resolve-withdraw.js";
import type {
  CapabilityDescriptor,
  CapabilityId,
  CapabilityTier,
  ConsentReceipt,
  InstallationCapabilitySelection,
  ModuleId,
  NetworkPolicy,
  ReasonCode,
  VaultCapabilitySelection,
  WorkspaceCapabilityRestriction,
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
  /** The vault selection belongs to another vault, installation or instance. */
  vaultForeign: boolean;
  required: ReadonlySet<CapabilityId>;
  accepted: ReadonlySet<CapabilityId>;
  selectedRoots: readonly CapabilityId[];
  /**
   * Roots a selection asked for that was accepted against a superseded
   * policy revision. They stay `selected` (the person did choose them) but
   * are never approved, and consent must be taken again.
   */
  staleRoots: readonly CapabilityId[];
  requiredNotAccepted: readonly CapabilityId[];
  evaluatedModules: ReadonlySet<ModuleId>;
  /**
   * Always-on capabilities a verified instance policy withdrew, and every
   * always-on one that needs them (ADR 0139). Core that is statically
   * linked can never be withdrawn: it has no module to leave unloaded.
   */
  withdrawn: ReadonlySet<CapabilityId>;
}>;

type Identity = Readonly<{
  instanceId: string;
  /** The selection when it addresses this instance and this device, else null. */
  installation: InstallationCapabilitySelection | null;
  /** It addresses us, but names a policy revision this instance has left behind. */
  stale: boolean;
  profileMismatch: boolean;
}>;

/**
 * A selection is accepted against one policy revision. A newer revision may
 * permit, require or prohibit different capabilities, so a selection whose
 * `basePolicyRevision` is not the current one states a choice nobody has
 * made under the policy in force — it is stale until the person re-accepts.
 */
function isCurrentSelection(input: ResolveInput): boolean {
  const policy = input.instancePolicy;
  if (policy === null || input.installation === null) return true;
  return input.installation.basePolicyRevision === policy.revision;
}

/** The installation counts only when it names this instance and this device. */
function resolveIdentity(input: ResolveInput): Identity {
  const instanceId =
    input.instancePolicy?.instanceId ??
    input.installation?.instanceId ??
    PERSONAL_LOCAL_INSTANCE;
  const addresses =
    input.installation !== null &&
    input.installation.instanceId === instanceId &&
    input.installation.installationId === input.installationId;
  const stale = addresses && !isCurrentSelection(input);
  return {
    instanceId,
    installation: addresses ? input.installation : null,
    stale,
    profileMismatch: input.installation !== null && (!addresses || stale),
  };
}

/** An unverified policy is fail-closed on the network; no policy is personal-local. */
function networkFor(input: ResolveInput): NetworkPolicy {
  if (!input.policyValid) return DENY_ALL_NETWORK;
  return input.instancePolicy === null
    ? PERSONAL_LOCAL_NETWORK
    : input.instancePolicy.network;
}

function selectedRootsOf(
  installation: InstallationCapabilitySelection | null,
): CapabilityId[] {
  if (installation === null) return [];
  return sortIds([
    ...installation.acceptedRequired,
    ...installation.selectedOptional,
  ]);
}

/** A restriction written for another instance or another vault binds nothing here. */
function isWorkspaceForeign(
  workspace: WorkspaceCapabilityRestriction | null,
  instanceId: string,
  vaultId: string | null,
): boolean {
  if (workspace === null) return false;
  return workspace.instanceId !== instanceId || workspace.vaultId !== vaultId;
}

/**
 * A vault selection written for another vault, installation or instance.
 *
 * The document carries all three ids for exactly this reason, and until they
 * were read they were dead weight: a record lifted from one tomb into another
 * narrowed a session it was never written for. A foreign one is treated the
 * way a foreign workspace restriction is — it denies rather than being
 * ignored, because a restriction that stops applying is a restriction that
 * widens, and this scope may only narrow (P-SCOPING).
 */
function isVaultForeign(
  vault: VaultCapabilitySelection | null,
  instanceId: string,
  installationId: string,
  vaultId: string | null,
): boolean {
  if (vault === null) return false;
  return (
    vault.instanceId !== instanceId ||
    vault.installationId !== installationId ||
    vault.vaultId !== vaultId
  );
}

/** Only catalog capabilities can be re-accepted; an unknown id is diagnosed, not offered. */
function staleRootsFor(
  stale: boolean,
  selectedRoots: readonly CapabilityId[],
  index: ReadonlyMap<CapabilityId, CapabilityDescriptor>,
): CapabilityId[] {
  if (!stale) return [];
  return selectedRoots.filter((id) => index.get(id)?.tier === "optional");
}

export function buildContext(input: ResolveInput): ResolveContext {
  const policy = input.instancePolicy;
  const { instanceId, installation, stale, profileMismatch } =
    resolveIdentity(input);
  const workspaceMismatch = isWorkspaceForeign(
    input.workspace,
    instanceId,
    input.vaultId,
  );
  const index = indexCatalog(input.catalog);
  // A core capability is in every plan already; a policy written before it
  // became core may still name it as required, and that is owed nothing.
  const required = new Set(
    (policy === null || !input.policyValid
      ? []
      : policy.capabilities.required
    ).filter((id) => index.get(id)?.tier !== "core"),
  );
  // A stale selection accepts nothing: every required root is owed again.
  const accepted = new Set(stale ? [] : (installation?.acceptedRequired ?? []));
  const selectedRoots = selectedRootsOf(installation);
  return {
    input,
    index,
    ids: sortIds(input.catalog.capabilities.map((d) => d.id)),
    instanceId,
    policyRevision: policy?.revision ?? PERSONAL_LOCAL_REVISION,
    selectionRevision: installation?.revision ?? NO_SELECTION_REVISION,
    installation,
    profileMismatch,
    workspaceMismatch,
    receipt: stale
      ? null
      : applicableReceipt(input.receipt, instanceId, input.installationId),
    network: networkFor(input),
    distributed: new Set(input.distribution.capabilityIds),
    distributedModules: new Set(input.distribution.moduleIds),
    vaultDisabled: new Set(input.vault?.disabled ?? []),
    vaultForeign: isVaultForeign(
      input.vault,
      instanceId,
      input.installationId,
      input.vaultId,
    ),
    required,
    accepted,
    selectedRoots,
    staleRoots: staleRootsFor(stale, selectedRoots, index),
    requiredNotAccepted: sortIds(
      [...required].filter((id) => !accepted.has(id)),
    ),
    evaluatedModules: new Set(input.facts.evaluatedModuleIds),
    withdrawn: withdrawnCore(input, index),
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

function runtimeSupports(
  ctx: ResolveContext,
  d: CapabilityDescriptor,
): boolean {
  const hosts = new Set(ctx.input.facts.environments);
  if (!d.environments.every((e) => hosts.has(e))) return false;
  if (
    d.environments.includes("service-worker") &&
    !ctx.input.facts.serviceWorkerAvailable
  ) {
    return false;
  }
  return true;
}

function workerVariantExists(ctx: ResolveContext, constraint: string): boolean {
  if (!ctx.input.facts.serviceWorkerAvailable) return false;
  return ctx.input.distribution.workerVariants.some((v) =>
    v.satisfies.includes(constraint),
  );
}

export function hasAutomaticExternalEgress(d: CapabilityDescriptor): boolean {
  return d.egress.some((e) => e.class === "external-service" && e.automatic);
}

function policyReasons(ctx: ResolveContext, id: CapabilityId): ReasonCode[] {
  const policy = ctx.input.instancePolicy;
  const out: ReasonCode[] = [];
  if (!ctx.input.policyValid) out.push("POLICY_UNVERIFIED");
  if (ctx.profileMismatch) out.push("PROFILE_MISMATCH");
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
  if (ctx.vaultForeign || ctx.vaultDisabled.has(d.id))
    blocked.push("DISABLED_IN_VAULT");
  if (!runtimeSupported) blocked.push("UNSUPPORTED_RUNTIME");
  if (
    hasAutomaticExternalEgress(d) &&
    ctx.network.externalServices === "deny"
  ) {
    blocked.push("NETWORK_POLICY_DENIES");
  }
  if (
    d.workerGraphConstraint !== null &&
    !workerVariantExists(ctx, d.workerGraphConstraint)
  ) {
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
  const withdrawn = ctx.withdrawn.has(d.id);
  return {
    id: d.id,
    tier: "core",
    distributed: true,
    permitted: !withdrawn,
    required: false,
    selected: !withdrawn,
    runtimeSupported: runtimeSupports(ctx, d),
    blocked: withdrawn ? ["PROHIBITED_BY_INSTANCE"] : [],
  };
}

export function computeAxes(
  ctx: ResolveContext,
): ReadonlyMap<CapabilityId, Axis> {
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
