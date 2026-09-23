/**
 * Runtime facts the resolver is handed and never reads for itself
 * (ownership.md §7 `RuntimeFacts`): which execution environments this realm
 * can host, whether a service worker is usable, which worker variant is in
 * control, and which optional modules this document has already evaluated —
 * the one fact that turns a revocation into `RESTART_REQUIRED` instead of a
 * pretence that unloading a module is possible.
 */

import type {
  ExecutionEnvironment,
  ModuleId,
  RuntimeFacts,
} from "@opensesame/capability-composition";
import { maybeEnvironment } from "../../ports.js";

const evaluated = new Set<ModuleId>();

/** Record that a module's import started in this realm. Irreversible. */
export function markModuleEvaluated(id: ModuleId): void {
  evaluated.add(id);
}

/** Module ids whose code has run in this document, sorted. */
export function evaluatedModuleIds(): readonly ModuleId[] {
  return [...evaluated].sort();
}

/** Test-only: a fresh realm. */
export function resetEvaluatedModulesForTest(): void {
  evaluated.clear();
}

function hostEnvironments(): ExecutionEnvironment[] {
  const out: ExecutionEnvironment[] = ["document"];
  const workers = maybeEnvironment()?.workers;
  if (workers?.dedicated) out.push("dedicated-worker");
  if (workers?.shared) out.push("shared-worker");
  if (serviceWorkerUsable()) out.push("service-worker");
  return out;
}

function serviceWorkerUsable(): boolean {
  try {
    return maybeEnvironment()?.workers.service === true;
  } catch {
    return false;
  }
}

export type CollectFactsInput = Readonly<{
  evaluatedModuleIds?: readonly ModuleId[];
  activeWorkerVariant: string | null;
  cleanRealm?: boolean;
  now: string;
}>;

/** Assemble the facts for one resolution. Deterministic given its input. */
export function collectRuntimeFacts(input: CollectFactsInput): RuntimeFacts {
  const evaluatedIds = input.evaluatedModuleIds ?? evaluatedModuleIds();
  return {
    environments: hostEnvironments(),
    serviceWorkerAvailable: serviceWorkerUsable(),
    activeWorkerVariant: input.activeWorkerVariant,
    cleanRealm: input.cleanRealm ?? evaluatedIds.length === 0,
    evaluatedModuleIds: [...evaluatedIds].sort(),
    now: input.now,
  };
}
