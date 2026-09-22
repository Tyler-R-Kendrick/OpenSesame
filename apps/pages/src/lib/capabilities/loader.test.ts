/** @vitest-environment jsdom */
/**
 * The loader and the change controller: an unknown or unapproved module is
 * refused before any import (LOAD-07); an import that started under a lease
 * revoked mid-flight is refused and leaves the plan reporting
 * RESTART_REQUIRED (LOAD-06); repeated enable/disable disposes every handle
 * and never duplicates a registration (LOAD-09).
 */

import type { RuntimeHandle } from "@opensesame/capability-composition";
import { beforeEach, describe, expect, it } from "vitest";
import { activatePlan } from "./change.js";
import { evaluatedModuleIds } from "./facts.js";
import {
  activateApprovedCapability,
  deactivateGeneration,
  liveHandleCount,
  loadApprovedModule,
  loaderSeams,
} from "./loader.js";
import { contributions } from "./registry.js";
import {
  type ApprovedCapabilityContext,
  type CapabilityModule,
  CapabilityDenied,
} from "./runtime-contract.js";
import { compositionStore } from "./store.js";
import {
  approved,
  bootPersonalLocal,
  draftFor,
  freshRealm,
  settle,
  until,
} from "./__tests__/harness.js";

const PASSKEYS = "vault.passkey-records";
const MODULE = `${PASSKEYS}/runtime`;

type Counters = { activations: number; disposals: number };

function fakeModule(counters: Counters): CapabilityModule {
  return {
    capabilityRuntime: {
      capability: PASSKEYS,
      async activate(ctx: ApprovedCapabilityContext): Promise<RuntimeHandle> {
        counters.activations += 1;
        ctx.register("route", {
          id: "passkeys.section",
          path: "/passkeys",
          element: () => null,
          framed: true,
          order: 10,
        });
        return {
          capability: PASSKEYS,
          dispose: () => {
            counters.disposals += 1;
          },
        };
      },
    },
  };
}

async function bootWithPasskeys(): Promise<void> {
  await bootPersonalLocal(compositionStore, "personal");
  const { draft, receipt } = draftFor(compositionStore, [PASSKEYS], "r1");
  const outcome = await compositionStore.commit(draft, receipt);
  if (outcome.status !== "committed") throw new Error(outcome.status);
}

beforeEach(freshRealm);

describe("loadApprovedModule (LOAD-07)", () => {
  it("refuses an id the distribution does not carry before touching the table", async () => {
    await bootPersonalLocal();
    let tableAsked = 0;
    loaderSeams.moduleTable = async () => {
      tableAsked += 1;
      return {};
    };
    const lease = compositionStore.currentLease();
    await expect(
      loadApprovedModule("nope.unknown/runtime", lease),
    ).rejects.toMatchObject({ name: "CapabilityDenied", code: "NOT_DISTRIBUTED" });
    expect(tableAsked).toBe(0);
  });

  it("refuses a distributed module the plan did not approve", async () => {
    await bootPersonalLocal();
    let imported = 0;
    loaderSeams.moduleTable = async () => ({
      [MODULE]: async () => {
        imported += 1;
        return fakeModule({ activations: 0, disposals: 0 });
      },
    });
    const lease = compositionStore.currentLease();
    await expect(loadApprovedModule(MODULE, lease)).rejects.toMatchObject({
      code: "NOT_APPROVED",
    });
    expect(imported).toBe(0);
    expect(evaluatedModuleIds()).toEqual([]);
  });

  it("refuses a module whose runtime names another capability", async () => {
    await bootWithPasskeys();
    loaderSeams.moduleTable = async () => ({
      [MODULE]: async () => ({
        capabilityRuntime: {
          capability: "telemetry.external",
          activate: async () => ({ capability: "telemetry.external", dispose() {} }),
        },
      }),
    });
    await expect(
      loadApprovedModule(MODULE, compositionStore.currentLease()),
    ).rejects.toMatchObject({ code: "INVALID_MODULE" });
  });

  it("imports a module once per distribution and hands the same namespace back", async () => {
    await bootWithPasskeys();
    let imported = 0;
    const counters = { activations: 0, disposals: 0 };
    loaderSeams.moduleTable = async () => ({
      [MODULE]: async () => {
        imported += 1;
        return fakeModule(counters);
      },
    });
    const lease = compositionStore.currentLease();
    const [a, b] = await Promise.all([
      loadApprovedModule(MODULE, lease),
      loadApprovedModule(MODULE, lease),
    ]);
    expect(a).toBe(b);
    expect(imported).toBe(1);
  });
});

describe("activateApprovedCapability", () => {
  it("LOAD-06: an import revoked mid-flight is refused and marks the realm dirty", async () => {
    await bootWithPasskeys();
    let release: (() => void) | null = null;
    const counters = { activations: 0, disposals: 0 };
    loaderSeams.moduleTable = async () => ({
      [MODULE]: () =>
        new Promise<CapabilityModule>((resolve) => {
          release = () => resolve(fakeModule(counters));
        }),
    });
    const lease = compositionStore.currentLease();
    const activation = activateApprovedCapability(PASSKEYS, lease);
    await until(() => release !== null);
    expect(evaluatedModuleIds()).toEqual([MODULE]);

    await compositionStore.emergencyDisable(PASSKEYS);
    (release as unknown as () => void)();

    await expect(activation).rejects.toBeInstanceOf(CapabilityDenied);
    expect(counters.activations).toBe(0);
    const state = compositionStore.getSnapshot().plan?.capabilities[PASSKEYS];
    expect(state?.approved).toBe(false);
    expect(state?.restartRequired).toBe(true);
    expect(state?.reasons).toContain("RESTART_REQUIRED");
    expect(compositionStore.getSnapshot().lifecycle[PASSKEYS]).toBe(
      "disabled-restart-required",
    );
  });

  it("disposes a handle whose lease went stale during activate", async () => {
    await bootWithPasskeys();
    const counters = { activations: 0, disposals: 0 };
    loaderSeams.moduleTable = async () => ({
      [MODULE]: async () => ({
        capabilityRuntime: {
          capability: PASSKEYS,
          async activate() {
            counters.activations += 1;
            compositionStore.invalidate("mid-activate");
            return {
              capability: PASSKEYS,
              dispose: () => {
                counters.disposals += 1;
              },
            };
          },
        },
      }),
    });
    const lease = compositionStore.currentLease();
    await expect(activateApprovedCapability(PASSKEYS, lease)).rejects.toMatchObject({
      code: "STALE_LEASE",
    });
    expect(counters.disposals).toBe(1);
    expect(liveHandleCount(lease.generation)).toBe(0);
  });

  it("registers contributions under the lease and revokes them with the generation", async () => {
    await bootWithPasskeys();
    const counters = { activations: 0, disposals: 0 };
    loaderSeams.moduleTable = async () => ({ [MODULE]: async () => fakeModule(counters) });
    const lease = compositionStore.currentLease();
    const handles = await activateApprovedCapability(PASSKEYS, lease);
    expect(handles).toHaveLength(1);
    expect(contributions("route").map((r) => r.id)).toEqual(["passkeys.section"]);
    expect(compositionStore.getSnapshot().lifecycle[PASSKEYS]).toBe("active");

    await deactivateGeneration(lease.generation);
    await deactivateGeneration(lease.generation);

    expect(counters.disposals).toBe(1);
    expect(contributions("route")).toEqual([]);
  });
});

describe("activatePlan (LOAD-09)", () => {
  it("repeated enable/disable disposes every handle and never duplicates a registration", async () => {
    await bootWithPasskeys();
    const counters = { activations: 0, disposals: 0 };
    loaderSeams.moduleTable = async () => ({ [MODULE]: async () => fakeModule(counters) });

    const stop = activatePlan(compositionStore);
    await until(() => counters.activations === 1);
    expect(contributions("route")).toHaveLength(1);

    for (let cycle = 1; cycle <= 3; cycle += 1) {
      compositionStore.invalidate(`cycle-${cycle}`);
      await until(() => counters.activations === cycle + 1);
      expect(counters.disposals).toBe(cycle);
      expect(contributions("route")).toHaveLength(1);
    }

    await compositionStore.emergencyDisable(PASSKEYS);
    await until(() => counters.disposals === 4);
    await settle();
    expect(contributions("route")).toEqual([]);
    expect(counters.activations).toBe(4);
    expect(approved(compositionStore)).not.toContain(PASSKEYS);

    stop();
    await settle();
    expect(counters.disposals).toBe(4);
  });
});
