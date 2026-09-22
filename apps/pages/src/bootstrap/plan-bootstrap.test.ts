import { describe, expect, it } from "vitest";
import { createLeaseStore } from "./plan-bootstrap.js";

const MOD = "mod.a" as never;

describe("plan bootstrap leases", () => {
  it("a minted lease is live until the plan is superseded", () => {
    const store = createLeaseStore();
    const lease = store.mint(MOD, "digest-1");
    expect(lease.expiresAtKind).toBe("plan-generation");
    expect(store.live(MOD)).toBe(true);
    expect(store.gate().allows(MOD, "digest-1")).toBe(true);
    store.supersede("digest-2");
    expect(store.live(MOD)).toBe(false);
    expect(store.gate().allows(MOD, "digest-1")).toBe(false);
    expect(store.gate().refusalReason?.(MOD)).toMatch(/no live lease/);
  });

  it("revocation is idempotent and refuses dispatch", () => {
    const store = createLeaseStore();
    store.mint(MOD, "digest-1");
    store.revoke(MOD);
    store.revoke(MOD);
    expect(store.live(MOD)).toBe(false);
    expect(store.gate().allows(MOD, "digest-1")).toBe(false);
    expect(store.gate().refusalReason?.(MOD)).toMatch(/revoked/);
  });

  it("a gate bound to the wrong digest refuses", () => {
    const store = createLeaseStore();
    store.mint(MOD, "digest-1");
    expect(store.gate().allows(MOD, "digest-2")).toBe(false);
  });
});
