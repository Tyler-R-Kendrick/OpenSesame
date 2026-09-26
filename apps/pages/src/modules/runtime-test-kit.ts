/**
 * Shared assertions for every module's `runtime.test.tsx`: importing the
 * runtime under spies proves the module graph has no top-level side effect,
 * and `expectLifecycle` proves activate → dispose → re-activate behaves the
 * way the loader relies on (LOAD-09: fresh handles under the new lease).
 */

import type {
  CapabilityModule,
  CapabilityRuntime,
} from "@opensesame/app-core/lib/capabilities/runtime-contract.js";
import { registerContributionForTest } from "@opensesame/app-core/lib/contributions.js";
import type { ContributionKind } from "@opensesame/capability-composition";
import { expect, vi } from "vitest";
import { type TestContextOptions, createTestContext } from "./test-context.js";

export type ImportSideEffects = Readonly<{
  fetch: number;
  setTimeout: number;
  setInterval: number;
  serviceWorkerRegister: number;
  windowListeners: number;
  documentListeners: number;
  customElements: number;
  storageWrites: number;
}>;

export const NO_SIDE_EFFECTS: ImportSideEffects = Object.freeze({
  fetch: 0,
  setTimeout: 0,
  setInterval: 0,
  serviceWorkerRegister: 0,
  windowListeners: 0,
  documentListeners: 0,
  customElements: 0,
  storageWrites: 0,
});

/**
 * Evaluate a module graph for the first time while every side-effect road
 * is spied. The loader must be a dynamic import the test file has not
 * imported statically anywhere, or the graph is already evaluated.
 */
/** A module evaluated under spies, and what its evaluation touched. */
export type SpiedImport<T> = Readonly<{
  module: T;
  effects: ImportSideEffects;
}>;

export async function importUnderSpies<T>(
  load: () => Promise<T>,
): Promise<SpiedImport<T>> {
  const serviceWorkerRegister = vi.fn(async () => {
    throw new Error("service worker registration during import");
  });
  const hadServiceWorker = "serviceWorker" in navigator;
  if (!hadServiceWorker) {
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: { register: serviceWorkerRegister, addEventListener: vi.fn() },
    });
  }
  const fetchSpy = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async () => {
      throw new Error("fetch during import");
    });
  const timeoutSpy = vi.spyOn(globalThis, "setTimeout");
  const intervalSpy = vi.spyOn(globalThis, "setInterval");
  const windowSpy = vi.spyOn(window, "addEventListener");
  const documentSpy = vi.spyOn(document, "addEventListener");
  const defineSpy = vi.spyOn(customElements, "define");
  const storageSpy = vi.spyOn(Storage.prototype, "setItem");
  try {
    const module = await load();
    return {
      module,
      effects: {
        fetch: fetchSpy.mock.calls.length,
        setTimeout: timeoutSpy.mock.calls.length,
        setInterval: intervalSpy.mock.calls.length,
        serviceWorkerRegister: serviceWorkerRegister.mock.calls.length,
        windowListeners: windowSpy.mock.calls.length,
        documentListeners: documentSpy.mock.calls.length,
        customElements: defineSpy.mock.calls.length,
        storageWrites: storageSpy.mock.calls.length,
      },
    };
  } finally {
    fetchSpy.mockRestore();
    timeoutSpy.mockRestore();
    intervalSpy.mockRestore();
    windowSpy.mockRestore();
    documentSpy.mockRestore();
    defineSpy.mockRestore();
    storageSpy.mockRestore();
    if (!hadServiceWorker) {
      Reflect.deleteProperty(navigator, "serviceWorker");
    }
  }
}

export function runtimeOf(
  module: Partial<CapabilityModule>,
): CapabilityRuntime {
  if (!module.capabilityRuntime) {
    throw new Error("module has no capabilityRuntime export");
  }
  return module.capabilityRuntime;
}

export type LifecycleExpectation = Readonly<{
  capability: string;
  /** Sorted, unique contribution kinds one activation registers. */
  kinds: readonly string[];
  /** Total registrations one activation performs. */
  count: number;
  context?: TestContextOptions;
}>;

/**
 * activate registers exactly `kinds` (`count` handles), dispose revokes
 * every one exactly once and is idempotent, an aborted lease disposes too,
 * and a second activate under a new lease registers fresh handles.
 */
export async function expectLifecycle(
  runtime: CapabilityRuntime,
  expectation: LifecycleExpectation,
): Promise<void> {
  expect(runtime.capability).toBe(expectation.capability);

  const first = createTestContext({ ...expectation.context, generation: 1 });
  const handle = await runtime.activate(first.ctx);
  expect(handle.capability).toBe(expectation.capability);
  expect(first.liveKinds()).toEqual([...expectation.kinds].sort());
  expect(first.registered).toHaveLength(expectation.count);

  await handle.dispose();
  expect(first.live()).toHaveLength(0);
  await handle.dispose();
  for (const record of first.registered) {
    expect(record.revokeCalls).toBe(1);
  }

  // LOAD-09: after dispose, a new lease gets new handles, never the old.
  const second = createTestContext({ ...expectation.context, generation: 2 });
  const again = await runtime.activate(second.ctx);
  expect(second.registered).toHaveLength(expectation.count);
  for (const record of second.registered) {
    expect(record.generation).toBe(2);
    expect(record.revoked).toBe(false);
  }
  expect(first.registered.every((record) => record.revoked)).toBe(true);

  // A lease abort disposes without anyone calling dispose.
  second.abort("lock");
  expect(second.live()).toHaveLength(0);
  await again.dispose();
  for (const record of second.registered) {
    expect(record.revokeCalls).toBe(1);
  }

  // An already-aborted lease registers nothing.
  const stale = createTestContext({ ...expectation.context, generation: 3 });
  stale.abort("superseded");
  const none = await runtime.activate(stale.ctx);
  expect(stale.registered).toHaveLength(0);
  await none.dispose();
}

/**
 * Test-only: activate a capability's real runtime and put what it registered
 * beside the registry's — what an installation that approved it draws. A
 * suite that proves a surface a capability contributes uses this rather
 * than hand-writing the entry. `kinds` narrows what is put in place.
 * Returns the revoke, which also disposes the runtime.
 */
export async function activateForTest(
  module: Partial<CapabilityModule>,
  kinds?: readonly ContributionKind[],
): Promise<() => void> {
  const t = createTestContext();
  const handle = await runtimeOf(module).activate(t.ctx);
  const revokes = t
    .live()
    .filter((record) => !kinds || kinds.includes(record.kind))
    .map((record) => registerContributionForTest(record.kind, record.entry));
  return () => {
    for (const revoke of revokes) revoke();
    void handle.dispose();
  };
}
