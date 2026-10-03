/** @vitest-environment jsdom */
/**
 * Operation authority: the synchronous check refuses before any handler
 * import, and admission fails closed on a stale durable generation or when
 * no cross-context serialization exists (LIFE-04). Admission holds the
 * instance lock through the operation, so a cross-context commit cannot
 * land between the check and the execution it admitted.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  NOW,
  bootPersonalLocal,
  durable,
  fakeLocks,
  freshRealm,
  settle,
  until,
} from "./__tests__/harness.js";
import {
  admitOperation,
  assertCurrentOperationAuthority,
} from "./authority.js";
import { GENERATION_KEY } from "./keys.js";
import { compositionStore, storeSeams } from "./store.js";

const CORE_OP = "pages.items.list";
const OPTIONAL_OP = "pages.items.passkey.create";

beforeEach(freshRealm);

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("assertCurrentOperationAuthority", () => {
  it("admits a core operation under a current lease", async () => {
    await bootPersonalLocal();
    expect(() =>
      assertCurrentOperationAuthority(CORE_OP, compositionStore.currentLease()),
    ).not.toThrow();
  });

  it("refuses an operation whose capability is not approved", async () => {
    await bootPersonalLocal();
    expect(() =>
      assertCurrentOperationAuthority(
        OPTIONAL_OP,
        compositionStore.currentLease(),
      ),
    ).toThrow(/NOT_APPROVED/);
  });

  it("refuses a stale lease before looking at the operation", async () => {
    await bootPersonalLocal();
    const lease = compositionStore.currentLease();
    compositionStore.invalidate("test");
    expect(() => assertCurrentOperationAuthority(CORE_OP, lease)).toThrow(
      /STALE_LEASE/,
    );
  });
});

describe("admitOperation (LIFE-04)", () => {
  it("admits when the durable generation matches and the lease is current", async () => {
    await bootPersonalLocal();
    const outcome = await admitOperation(
      CORE_OP,
      compositionStore.currentLease(),
      () => "ran",
    );
    expect(outcome).toEqual({
      decision: { admitted: true, committedGeneration: 0, reason: "current" },
      result: "ran",
    });
  });

  it("refuses when another context advanced the durable generation", async () => {
    await bootPersonalLocal();
    const lease = compositionStore.currentLease();
    durable.set(
      GENERATION_KEY,
      JSON.stringify({ generation: 7, committedAt: NOW }),
    );
    const outcome = await admitOperation(CORE_OP, lease, () => "ran");
    expect(outcome).toEqual({
      decision: {
        admitted: false,
        committedGeneration: 7,
        reason: "stale-generation",
      },
      result: undefined,
    });
  });

  it("refuses a stale lease even when storage agrees", async () => {
    await bootPersonalLocal();
    const lease = compositionStore.currentLease();
    compositionStore.invalidate("lock");
    const outcome = await admitOperation(CORE_OP, lease, () => "ran");
    expect(outcome.decision.admitted).toBe(false);
    expect(outcome.decision.reason).toBe("stale-generation");
  });

  it("refuses an unapproved operation", async () => {
    await bootPersonalLocal();
    const outcome = await admitOperation(
      OPTIONAL_OP,
      compositionStore.currentLease(),
      () => "ran",
    );
    expect(outcome).toEqual({
      decision: {
        admitted: false,
        committedGeneration: 0,
        reason: "not-approved",
      },
      result: undefined,
    });
  });

  it("fails closed without Web Locks", async () => {
    await bootPersonalLocal();
    storeSeams.locks = () => undefined;
    const outcome = await admitOperation(
      CORE_OP,
      compositionStore.currentLease(),
      () => "ran",
    );
    expect(outcome).toEqual({
      decision: {
        admitted: false,
        committedGeneration: 0,
        reason: "no-serialization",
      },
      result: undefined,
    });
  });

  it("never runs the operation when admission is refused", async () => {
    await bootPersonalLocal();
    const operation = vi.fn(() => "ran");
    const outcome = await admitOperation(
      OPTIONAL_OP,
      compositionStore.currentLease(),
      operation,
    );
    expect(outcome.decision.admitted).toBe(false);
    expect(outcome.result).toBeUndefined();
    expect(operation).not.toHaveBeenCalled();
  });

  it("holds the lock from admission through the operation's completion", async () => {
    const shared = fakeLocks();
    storeSeams.locks = () => shared;
    await bootPersonalLocal();
    const order: string[] = [];
    const gate = deferred();
    const first = admitOperation(
      CORE_OP,
      compositionStore.currentLease(),
      async () => {
        order.push("first-start");
        await gate.promise;
        order.push("first-end");
        return "done";
      },
    );
    await until(() => order.includes("first-start"));
    const second = admitOperation(
      CORE_OP,
      compositionStore.currentLease(),
      () => {
        order.push("second");
      },
    );
    for (let i = 0; i < 10; i++) await settle();
    expect(order).toEqual(["first-start"]);
    gate.resolve();
    const firstOutcome = await first;
    await second;
    expect(order).toEqual(["first-start", "first-end", "second"]);
    expect(firstOutcome.decision.admitted).toBe(true);
    expect(firstOutcome.result).toBe("done");
  });

  it("propagates the operation's own failure instead of reporting a lock failure", async () => {
    await bootPersonalLocal();
    await expect(
      admitOperation(CORE_OP, compositionStore.currentLease(), () => {
        throw new Error("operation failed");
      }),
    ).rejects.toThrow("operation failed");
  });
});
