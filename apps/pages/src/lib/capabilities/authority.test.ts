/** @vitest-environment jsdom */
/**
 * Operation authority: the synchronous check refuses before any handler
 * import, and admission fails closed on a stale durable generation or when
 * no cross-context serialization exists (LIFE-04).
 */

import { beforeEach, describe, expect, it } from "vitest";
import { admitOperation, assertCurrentOperationAuthority } from "./authority.js";
import { GENERATION_KEY } from "./keys.js";
import { compositionStore, storeSeams } from "./store.js";
import { NOW, bootPersonalLocal, durable, freshRealm } from "./__tests__/harness.js";

const CORE_OP = "pages.items.list";
const OPTIONAL_OP = "pages.items.passkey.create";

beforeEach(freshRealm);

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
      assertCurrentOperationAuthority(OPTIONAL_OP, compositionStore.currentLease()),
    ).toThrow(/NOT_APPROVED/);
  });

  it("refuses a stale lease before looking at the operation", async () => {
    await bootPersonalLocal();
    const lease = compositionStore.currentLease();
    compositionStore.invalidate("test");
    expect(() => assertCurrentOperationAuthority(CORE_OP, lease)).toThrow(/STALE_LEASE/);
  });
});

describe("admitOperation (LIFE-04)", () => {
  it("admits when the durable generation matches and the lease is current", async () => {
    await bootPersonalLocal();
    const decision = await admitOperation(CORE_OP, compositionStore.currentLease());
    expect(decision).toEqual({ admitted: true, committedGeneration: 0, reason: "current" });
  });

  it("refuses when another context advanced the durable generation", async () => {
    await bootPersonalLocal();
    const lease = compositionStore.currentLease();
    durable.set(GENERATION_KEY, JSON.stringify({ generation: 7, committedAt: NOW }));
    const decision = await admitOperation(CORE_OP, lease);
    expect(decision).toEqual({
      admitted: false,
      committedGeneration: 7,
      reason: "stale-generation",
    });
  });

  it("refuses a stale lease even when storage agrees", async () => {
    await bootPersonalLocal();
    const lease = compositionStore.currentLease();
    compositionStore.invalidate("lock");
    const decision = await admitOperation(CORE_OP, lease);
    expect(decision.admitted).toBe(false);
    expect(decision.reason).toBe("stale-generation");
  });

  it("refuses an unapproved operation", async () => {
    await bootPersonalLocal();
    const decision = await admitOperation(OPTIONAL_OP, compositionStore.currentLease());
    expect(decision).toEqual({ admitted: false, committedGeneration: 0, reason: "not-approved" });
  });

  it("fails closed without Web Locks", async () => {
    await bootPersonalLocal();
    storeSeams.locks = () => undefined;
    const decision = await admitOperation(CORE_OP, compositionStore.currentLease());
    expect(decision).toEqual({
      admitted: false,
      committedGeneration: 0,
      reason: "no-serialization",
    });
  });
});
