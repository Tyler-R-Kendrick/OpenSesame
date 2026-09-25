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
  type ConsentCandidates,
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

/** Core in every plan — less what an operator withdrew (ADR 0142). */
function coreIds(ctx: ResolveContext): CapabilityId[] {
  return ctx.ids.filter(
    (id) => ctx.index.get(id)?.tier === "core" && !ctx.withdrawn.has(id),
  );
}

function runPass(
  ctx: ResolveContext,
  axes: ReadonlyMap<CapabilityId, Axis>,
  joinRefused: boolean,
): Pass {
  const chosen = ctx.installation?.chosenAlternatives ?? {};
  const closure = computeClosure(ctx.index, axes, ctx.selectedRoots, chosen);
  const candidates = joinRefused ? new Set<CapabilityId>() : closure.members;
  const approved = new Set<CapabilityId>(coreIds(ctx));
  for (const id of candidates) {
    const digest = ctx.index.get(id)?.exposureDigest ?? "";
    if (receiptCovers(ctx.receipt, id, digest)) approved.add(id);
  }
  const worker = selectWorkerVariant(
    approved,
    ctx.index,
    ctx.input.distribution,
    ctx.input.facts,
  );
  return { axes, closure, candidates, approved, worker };
}

function requiredConflicts(
  ctx: ResolveContext,
  axes: ReadonlyMap<CapabilityId, Axis>,
): PlanConflict[] {
  const out: PlanConflict[] = [];
  for (const id of sortIds(ctx.required)) {
    const axis = axes.get(id);
    if (axis === undefined) continue;
    if (!axis.distributed) {
      out.push({
        code: "REQUIRED_NOT_DISTRIBUTED",
        capability: id,
        subject: id,
        message: `required \`${id}\` is not in this distribution`,
      });
    }
    if (
      axis.blocked.includes("PROHIBITED_BY_INSTANCE") ||
      axis.blocked.includes("DENIED_BY_WORKSPACE")
    ) {
      out.push({
        code: "REQUIRED_PROHIBITED",
        capability: id,
        subject: id,
        message: `required \`${id}\` is prohibited by a narrower scope`,
      });
    }
  }
  return out;
}

/** A selected root no distributed worker variant can serve is a conflict on itself. */
function blockedRootWorkerConflicts(
  ctx: ResolveContext,
  axes: ReadonlyMap<CapabilityId, Axis>,
): PlanConflict[] {
  const out: PlanConflict[] = [];
  for (const id of ctx.selectedRoots) {
    const axis = axes.get(id);
    const constraint = ctx.index.get(id)?.workerGraphConstraint;
    if (axis === undefined || constraint === undefined || constraint === null)
      continue;
    if (!axis.blocked.includes("WORKER_GRAPH_UNAVAILABLE")) continue;
    out.push({
      code: "WORKER_GRAPH_UNAVAILABLE",
      capability: id,
      subject: constraint,
      message: `no distributed worker variant satisfies \`${constraint}\``,
    });
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
  if (axis.required && !ctx.accepted.has(id))
    reasons.push("REQUIRED_NOT_ACCEPTED");
  if (joinRefused && pass.closure.members.has(id))
    reasons.push("REQUIRED_NOT_ACCEPTED");
  const rootConflicts = pass.closure.rootConflicts.get(id);
  if (rootConflicts !== undefined) {
    reasons.push("DEPENDENCY_CONFLICT");
    if (rootConflicts.some((c) => c.code === "ALTERNATIVE_NOT_CHOSEN"))
      reasons.push("ALTERNATIVE_NOT_CHOSEN");
  } else if (pass.closure.reached.has(id) && !pass.closure.members.has(id)) {
    reasons.push("DEPENDENCY_CONFLICT");
  }
  if (pass.candidates.has(id) && !pass.approved.has(id))
    reasons.push("CONSENT_REQUIRED");
  return reasons;
}

function buildState(
  ctx: ResolveContext,
  pass: Pass,
  axis: Axis,
  joinRefused: boolean,
): CapabilityState {
  const d = ctx.index.get(axis.id);
  const withdrawn = ctx.withdrawn.has(axis.id);
  const approved =
    (axis.tier === "core" && !withdrawn) || pass.approved.has(axis.id);
  const reasons =
    axis.tier === "core"
      ? withdrawn
        ? ["PROHIBITED_BY_INSTANCE" as const]
        : ["CORE" as const]
      : optionalReasons(ctx, pass, axis, joinRefused);
  if (pass.worker.unavailable.has(axis.id))
    reasons.push("WORKER_GRAPH_UNAVAILABLE");
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

function collect(
  ctx: ResolveContext,
  approved: ReadonlySet<CapabilityId>,
  pick: "moduleIds" | "operationIds" | "itemKinds",
): string[] {
  const out: string[] = [];
  for (const id of approved) {
    const d = ctx.index.get(id);
    if (d === undefined) continue;
    for (const value of d[pick]) {
      if (pick !== "moduleIds" || ctx.distributedModules.has(value))
        out.push(value);
    }
  }
  return sortIds(out);
}

/**
 * One pass normally; a second when the approved set's worker constraints
 * cannot be served together, with those capabilities blocked. The second
 * pass approves a subset of the first, so it always terminates clean.
 */
function resolvePasses(
  ctx: ResolveContext,
  initialAxes: ReadonlyMap<CapabilityId, Axis>,
  joinRefused: boolean,
): Pass {
  const first = runPass(ctx, initialAxes, joinRefused);
  if (first.worker.unavailable.size === 0) return first;
  const blocked = blockAxes(
    first.axes,
    first.worker.unavailable,
    "WORKER_GRAPH_UNAVAILABLE",
  );
  const second = runPass(ctx, blocked, joinRefused);
  return {
    ...second,
    worker: {
      variant: second.worker.variant,
      unavailable: new Set([
        ...first.worker.unavailable,
        ...second.worker.unavailable,
      ]),
      conflicts: [...first.worker.conflicts, ...second.worker.conflicts],
    },
  };
}

/**
 * What consent is being asked about. A stale selection asks about the roots
 * it named — they need accepting again under the current policy revision —
 * and about nothing else, since none of them can be approved.
 */
function consentCandidates(
  ctx: ResolveContext,
  joinRefused: boolean,
  roots: readonly CapabilityId[],
  pass: Pass,
): ConsentCandidates {
  if (ctx.staleRoots.length > 0) return { roots: ctx.staleRoots, closure: [] };
  if (joinRefused) return EMPTY_CANDIDATES;
  return { roots, closure: sortIds(pass.candidates) };
}

export function resolveComposition(input: ResolveInput): EffectivePlan {
  const ctx = buildContext(input);
  const joinRefused = ctx.requiredNotAccepted.length > 0;
  const initialAxes = computeAxes(ctx);
  const pass = resolvePasses(ctx, initialAxes, joinRefused);
  const capabilities: Record<CapabilityId, CapabilityState> = {};
  for (const id of ctx.ids) {
    const axis = pass.axes.get(id);
    if (axis !== undefined)
      capabilities[id] = buildState(ctx, pass, axis, joinRefused);
  }
  const roots = sortIds(
    [...pass.candidates].filter((id) => ctx.selectedRoots.includes(id)),
  );
  const candidates = consentCandidates(ctx, joinRefused, roots, pass);
  const consent = consentDeltaFor(
    candidates,
    catalogDigests(input.catalog),
    ctx.receipt,
    ctx.requiredNotAccepted,
  );
  const conflicts = sortConflicts([
    ...[...pass.closure.rootConflicts.values()].flat(),
    ...requiredConflicts(ctx, pass.axes),
    ...blockedRootWorkerConflicts(ctx, initialAxes),
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
  return {
    ...body,
    identity: { ...body.identity, planDigest: planDigest(body) },
  };
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

export function explainCapability(
  plan: EffectivePlan,
  id: CapabilityId,
): CapabilityExplanation {
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
    conflicts: plan.conflicts.filter(
      (c) => c.capability === id || c.subject === id,
    ),
  };
}
