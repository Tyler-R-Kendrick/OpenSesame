/**
 * The deterministic resolver.
 *
 * Pure over `ResolveInput`: the same input in any order produces the same
 * plan and the same digest. Core is always approved; an optional capability
 * is approved only when it is distributed, permitted by every scope,
 * runtime-supported, network-allowed, selected (or pulled in by a clean
 * root), covered by a consent receipt, and served by a single worker variant.
 */
import { planDigest, sortConflicts } from "./canonical.js";
import {
  EMPTY_CANDIDATES,
  catalogDigests,
  consentDeltaFor,
  receiptCovers,
} from "./consent.js";
import { sortIds } from "./ids.js";
import { sortReasons } from "./reasons.js";
import {
  type Axis,
  type ResolveContext,
  blockAxes,
  buildContext,
  computeAxes,
} from "./resolve-axes.js";
import { type ClosureResult, computeClosure } from "./resolve-closure.js";
import type { ResolveInput } from "./resolve-input.js";
import { type WorkerSelection, selectWorkerVariant } from "./resolve-worker.js";
import type {
  CapabilityExplanation,
  CapabilityId,
  CapabilityState,
  EffectivePlan,
  PlanConflict,
  ReasonCode,
} from "./types.js";

export type { ResolveInput } from "./resolve-input.js";

type Pass = Readonly<{
  axes: ReadonlyMap<CapabilityId, Axis>;
  closure: ClosureResult;
  /** Members of clean roots, before join refusal and consent. */
  candidates: ReadonlySet<CapabilityId>;
  approved: ReadonlySet<CapabilityId>;
  worker: WorkerSelection;
}>;

function coreIds(ctx: ResolveContext): CapabilityId[] {
  return ctx.ids.filter((id) => ctx.index.get(id)?.tier === "core");
}

function runPass(ctx: ResolveContext, axes: ReadonlyMap<CapabilityId, Axis>, joinRefused: boolean): Pass {
  const chosen = ctx.installation?.chosenAlternatives ?? {};
  const closure = computeClosure(ctx.index, axes, ctx.selectedRoots, chosen);
  const candidates = joinRefused ? new Set<CapabilityId>() : closure.members;
  const approved = new Set<CapabilityId>(coreIds(ctx));
  for (const id of candidates) {
    const digest = ctx.index.get(id)?.exposureDigest ?? "";
    if (receiptCovers(ctx.receipt, id, digest)) approved.add(id);
  }
  const worker = selectWorkerVariant(approved, ctx.index, ctx.input.distribution, ctx.input.facts);
  return { axes, closure, candidates, approved, worker };
}

function requiredConflicts(ctx: ResolveContext, axes: ReadonlyMap<CapabilityId, Axis>): PlanConflict[] {
  const out: PlanConflict[] = [];
  for (const id of sortIds(ctx.required)) {
    const axis = axes.get(id);
    if (axis === undefined) continue;
    if (!axis.distributed) {
      out.push({ code: "REQUIRED_NOT_DISTRIBUTED", capability: id, subject: id, message: `required \`${id}\` is not in this distribution` });
    }
    if (axis.blocked.includes("PROHIBITED_BY_INSTANCE") || axis.blocked.includes("DENIED_BY_WORKSPACE")) {
      out.push({ code: "REQUIRED_PROHIBITED", capability: id, subject: id, message: `required \`${id}\` is prohibited by a narrower scope` });
    }
  }
  return out;
}

function optionalReasons(
  ctx: ResolveContext,
  pass: Pass,
  axis: Axis,
  joinRefused: boolean,
): ReasonCode[] {
  const id = axis.id;
  const reasons: ReasonCode[] = [...axis.blocked];
  const named = pass.closure.dependents.has(id);
  if (!axis.selected && !named) reasons.push("NOT_SELECTED");
  if (axis.required && !ctx.accepted.has(id)) reasons.push("REQUIRED_NOT_ACCEPTED");
  if (joinRefused && pass.closure.members.has(id)) reasons.push("REQUIRED_NOT_ACCEPTED");
  const rootConflicts = pass.closure.rootConflicts.get(id);
  if (rootConflicts !== undefined) {
    reasons.push("DEPENDENCY_CONFLICT");
    if (rootConflicts.some((c) => c.code === "ALTERNATIVE_NOT_CHOSEN")) reasons.push("ALTERNATIVE_NOT_CHOSEN");
  } else if (pass.closure.reached.has(id) && !pass.closure.members.has(id)) {
    reasons.push("DEPENDENCY_CONFLICT");
  }
  if (pass.candidates.has(id) && !pass.approved.has(id)) reasons.push("CONSENT_REQUIRED");
  return reasons;
}

function buildState(ctx: ResolveContext, pass: Pass, axis: Axis, joinRefused: boolean): CapabilityState {
  const d = ctx.index.get(axis.id);
  const approved = axis.tier === "core" || pass.approved.has(axis.id);
  const reasons = axis.tier === "core" ? ["CORE" as const] : optionalReasons(ctx, pass, axis, joinRefused);
  if (pass.worker.unavailable.has(axis.id)) reasons.push("WORKER_GRAPH_UNAVAILABLE");
  const restartRequired =
    !approved && (d?.moduleIds ?? []).some((m) => ctx.evaluatedModules.has(m));
  if (restartRequired) reasons.push("RESTART_REQUIRED");
  return {
    id: axis.id,
    tier: axis.tier,
    distributed: axis.distributed,
    permitted: axis.permitted,
    required: axis.required,
    selected: axis.selected,
    dependencyOf: sortIds(pass.closure.dependents.get(axis.id) ?? []),
    runtimeSupported: axis.runtimeSupported,
    approved,
    restartRequired,
    reasons: sortReasons(reasons),
  };
}

function collect(ctx: ResolveContext, approved: ReadonlySet<CapabilityId>, pick: "moduleIds" | "operationIds" | "itemKinds"): string[] {
  const out: string[] = [];
  for (const id of approved) {
    const d = ctx.index.get(id);
    if (d === undefined) continue;
    for (const value of d[pick]) {
      if (pick !== "moduleIds" || ctx.distributedModules.has(value)) out.push(value);
    }
  }
  return sortIds(out);
}

export function resolveComposition(input: ResolveInput): EffectivePlan {
  const ctx = buildContext(input);
  const joinRefused = ctx.requiredNotAccepted.length > 0;
  let pass = runPass(ctx, computeAxes(ctx), joinRefused);
  if (pass.worker.unavailable.size > 0) {
    const workerConflicts = pass.worker.conflicts;
    pass = runPass(ctx, blockAxes(pass.axes, pass.worker.unavailable, "WORKER_GRAPH_UNAVAILABLE"), joinRefused);
    pass = { ...pass, worker: { ...pass.worker, unavailable: new Set([...workerConflicts.map((c) => c.capability), ...pass.worker.unavailable]), conflicts: [...workerConflicts, ...pass.worker.conflicts] } };
  }
  const capabilities: Record<CapabilityId, CapabilityState> = {};
  for (const id of ctx.ids) {
    const axis = pass.axes.get(id);
    if (axis !== undefined) capabilities[id] = buildState(ctx, pass, axis, joinRefused);
  }
  const roots = sortIds([...pass.candidates].filter((id) => ctx.selectedRoots.includes(id)));
  const candidates = joinRefused ? EMPTY_CANDIDATES : { roots, closure: sortIds(pass.candidates) };
  const consent = consentDeltaFor(candidates, catalogDigests(input.catalog), ctx.receipt, ctx.requiredNotAccepted);
  const conflicts = sortConflicts([
    ...[...pass.closure.rootConflicts.values()].flat(),
    ...requiredConflicts(ctx, pass.axes),
    ...pass.worker.conflicts,
  ]);
  const body = {
    identity: {
      instanceId: ctx.instanceId,
      installationId: input.installationId,
      vaultId: input.vaultId,
      distributionId: input.distribution.distributionId,
      policyRevision: ctx.policyRevision,
      selectionRevision: ctx.selectionRevision,
    },
    provenance: input.provenance,
    policyValid: input.policyValid,
    capabilities,
    approvedCapabilities: sortIds(pass.approved),
    approvedModules: collect(ctx, pass.approved, "moduleIds"),
    approvedOperations: collect(ctx, pass.approved, "operationIds"),
    approvedItemKinds: collect(ctx, pass.approved, "itemKinds"),
    requiredWorkerVariant: pass.worker.variant,
    conflicts,
    consent,
    network: ctx.network,
  };
  return { ...body, identity: { ...body.identity, planDigest: planDigest(body) } };
}

/** Fail-closed stand-in for an id the plan does not know. */
function unknownState(id: CapabilityId): CapabilityState {
  return {
    id,
    tier: "optional",
    distributed: false,
    permitted: false,
    required: false,
    selected: false,
    dependencyOf: [],
    runtimeSupported: false,
    approved: false,
    restartRequired: false,
    reasons: ["NOT_DISTRIBUTED"],
  };
}

export function explainCapability(plan: EffectivePlan, id: CapabilityId): CapabilityExplanation {
  const state = plan.capabilities[id] ?? unknownState(id);
  const via: CapabilityId[] = [];
  const seen = new Set<CapabilityId>([id]);
  let current = state;
  while (!current.selected && current.dependencyOf.length > 0) {
    const parent = current.dependencyOf.find((p) => !seen.has(p));
    const next = parent === undefined ? undefined : plan.capabilities[parent];
    if (parent === undefined || next === undefined) break;
    seen.add(parent);
    via.unshift(parent);
    current = next;
  }
  return {
    id,
    state,
    via,
    conflicts: plan.conflicts.filter((c) => c.capability === id || c.subject === id),
  };
}
