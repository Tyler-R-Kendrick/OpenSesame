/**
 * The loader (ownership.md §4.2): the only way optional code enters this
 * document.
 *
 * `loadApprovedModule` checks the lease and the plan *before* it touches the
 * module table, and the table maps a compile-time-known module id to an
 * import — never a URL, never a path a caller supplied. An id the build did
 * not distribute is `NOT_DISTRIBUTED`; one the plan did not approve is
 * `NOT_APPROVED`; both are decided before any import starts. The import is
 * single-flight per distribution and module, because a module's namespace
 * is shared realm state; authority is not — every `await` is followed by a
 * fresh lease check, and a module whose lease went stale mid-import is
 * marked evaluated so the plan reports `RESTART_REQUIRED` instead of
 * pretending it can be unloaded.
 */

import type {
  ActivationLease,
  CapabilityId,
  ModuleId,
  RuntimeHandle,
} from "@opensesame/capability-composition";
import { capabilityArtifacts } from "../../host.js";
import { kvHydrate } from "../kv.js";
import { routerSeam } from "../router-seam.js";
import { runtimeConfigSnapshot } from "../runtime-config.js";
import { egressSeams } from "./egress-default.js";
import { markModuleEvaluated } from "./facts.js";
import { assertLeaseCurrent, deriveLease, leaseIsCurrent } from "./lease.js";
import {
  bindLeaseToCapability,
  registerContribution,
  revokeGeneration,
} from "./registry.js";
import {
  type ApprovedCapabilityContext,
  CapabilityDenied,
  type CapabilityModule,
} from "./runtime-contract.js";
import { compositionStore } from "./store.js";

export type ModuleTable = Readonly<
  Record<ModuleId, () => Promise<CapabilityModule>>
>;

export const loaderSeams = {
  moduleTable: (): Promise<ModuleTable> => capabilityArtifacts().moduleTable(),
  /** Set by the change controller once the vault store is in scope. */
  vaultContext: (): { tomb: string | null; guest: boolean } => ({
    tomb: null,
    guest: false,
  }),
  hydrate: (keys: readonly string[]): Promise<void> => kvHydrate([...keys]),
};

const modules = new Map<string, Promise<CapabilityModule>>();
const handlesByGeneration = new Map<number, RuntimeHandle[]>();
let tablePromise: Promise<ModuleTable> | null = null;

function currentGeneration(): number {
  return compositionStore.getSnapshot().generation;
}

function moduleCapability(id: ModuleId): CapabilityId {
  const slash = id.indexOf("/");
  return slash > 0 ? id.slice(0, slash) : id;
}

function validateModule(id: ModuleId, value: unknown): CapabilityModule {
  const runtime =
    typeof value === "object" && value !== null
      ? (value as { capabilityRuntime?: unknown }).capabilityRuntime
      : undefined;
  if (
    typeof runtime !== "object" ||
    runtime === null ||
    typeof (runtime as { activate?: unknown }).activate !== "function" ||
    (runtime as { capability?: unknown }).capability !== moduleCapability(id)
  ) {
    throw new CapabilityDenied("INVALID_MODULE", id);
  }
  return value as CapabilityModule;
}

function table(): Promise<ModuleTable> {
  tablePromise ??= loaderSeams.moduleTable().catch((error: unknown) => {
    tablePromise = null;
    throw error;
  });
  return tablePromise;
}

export async function loadApprovedModule(
  id: ModuleId,
  lease: ActivationLease,
): Promise<CapabilityModule> {
  const snapshot = compositionStore.getSnapshot();
  assertLeaseCurrent(lease, snapshot.generation, id);
  const plan = snapshot.plan;
  if (!plan) throw new CapabilityDenied("NOT_RESOLVED", id);
  if (!plan.approvedModules.includes(id)) {
    const distributed = plan.capabilities[moduleCapability(id)]?.distributed;
    throw new CapabilityDenied(
      distributed ? "NOT_APPROVED" : "NOT_DISTRIBUTED",
      id,
    );
  }
  const entries = await table();
  assertLeaseCurrent(lease, currentGeneration(), id);
  const key = `${plan.identity.distributionId}::${id}`;
  let pending = modules.get(key);
  if (!pending) {
    const importer = Object.hasOwn(entries, id) ? entries[id] : undefined;
    if (typeof importer !== "function") {
      throw new CapabilityDenied("NOT_DISTRIBUTED", id);
    }
    markModuleEvaluated(id);
    pending = importer().then((value) => validateModule(id, value));
    modules.set(key, pending);
    pending.catch(() => modules.delete(key));
  }
  const loaded = await pending;
  assertLeaseCurrent(lease, currentGeneration(), id);
  return loaded;
}

async function disposeHandles(
  handles: readonly RuntimeHandle[],
): Promise<void> {
  for (const handle of handles) {
    try {
      await handle.dispose();
    } catch (error) {
      compositionStore.note(
        `dispose ${handle.capability}: ${error instanceof Error ? error.name : "failed"}`,
      );
    }
  }
}

/** Keep a handle for its generation, or dispose it at once when that generation is gone. */
async function track(
  generation: number,
  handle: RuntimeHandle,
): Promise<boolean> {
  if (generation !== currentGeneration()) {
    await disposeHandles([handle]);
    return false;
  }
  const list = handlesByGeneration.get(generation) ?? [];
  list.push(handle);
  handlesByGeneration.set(generation, list);
  return true;
}

function contextFor(
  capability: CapabilityId,
  lease: ActivationLease,
): ApprovedCapabilityContext {
  const vault = {
    get tomb() {
      return loaderSeams.vaultContext().tomb;
    },
    get guest() {
      return loaderSeams.vaultContext().guest;
    },
  };
  return {
    lease,
    register: (kind, entry) => registerContribution(kind, entry, lease),
    runtimeConfig: runtimeConfigSnapshot(),
    hydrate: (keys) => loaderSeams.hydrate(keys),
    vault,
    egress: egressSeams.createEgressPort(capability),
    // The router, for a module whose tools move the person between authored
    // destinations. The seam throws until the shell is mounted, which is the
    // honest answer outside the app (router-seam.ts).
    navigate: (to: string) => routerSeam.navigate(to),
  };
}

function pageModulesOf(
  capability: CapabilityId,
  approved: readonly ModuleId[],
): ModuleId[] {
  return approved.filter(
    (id) => moduleCapability(id) === capability && !id.endsWith("/worker"),
  );
}

export async function activateApprovedCapability(
  id: CapabilityId,
  lease: ActivationLease,
): Promise<RuntimeHandle[]> {
  const snapshot = compositionStore.getSnapshot();
  assertLeaseCurrent(lease, snapshot.generation, id);
  const plan = snapshot.plan;
  if (!plan) throw new CapabilityDenied("NOT_RESOLVED", id);
  if (!plan.approvedCapabilities.includes(id)) {
    throw new CapabilityDenied(
      plan.capabilities[id]?.distributed ? "NOT_APPROVED" : "NOT_DISTRIBUTED",
      id,
    );
  }
  const child = deriveLease(lease);
  bindLeaseToCapability(child.lease, id);
  const ctx = contextFor(id, child.lease);
  const handles: RuntimeHandle[] = [];
  compositionStore.setActivity(id, "loading");
  try {
    for (const moduleId of pageModulesOf(id, plan.approvedModules)) {
      const loaded = await loadApprovedModule(moduleId, lease);
      assertLeaseCurrent(lease, currentGeneration(), moduleId);
      const handle = await loaded.capabilityRuntime.activate(ctx);
      if (!(await track(lease.generation, handle))) {
        throw new CapabilityDenied("STALE_LEASE", moduleId);
      }
      handles.push(handle);
    }
    if (!leaseIsCurrent(lease, currentGeneration())) {
      throw new CapabilityDenied("STALE_LEASE", id);
    }
    compositionStore.setActivity(id, "active");
    return handles;
  } catch (error) {
    child.abort("activation-failed");
    await disposeHandles(handles);
    if (leaseIsCurrent(lease, currentGeneration())) {
      compositionStore.setActivity(id, null);
    }
    throw error;
  }
}

/** Dispose every handle minted under `generation` and drop its registrations. Idempotent. */
export async function deactivateGeneration(generation: number): Promise<void> {
  const handles = handlesByGeneration.get(generation) ?? [];
  handlesByGeneration.delete(generation);
  revokeGeneration(generation);
  await disposeHandles([...handles].reverse());
}

/** Handles still held for a generation (tests and diagnostics). */
export function liveHandleCount(generation: number): number {
  return handlesByGeneration.get(generation)?.length ?? 0;
}

/** Test-only: forget cached modules and the module table. */
export function resetLoaderForTest(): void {
  modules.clear();
  handlesByGeneration.clear();
  tablePromise = null;
}
