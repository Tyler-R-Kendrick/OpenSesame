/**
 * Activation leases on their own — carried forward from #470's lease store
 * tests (plan-bootstrap.test): a lease is current until its generation is
 * superseded (LIFE-02), revocation is idempotent, a derived lease falls with
 * its parent, and only a lease this module minted counts at all.
 */
import type {
  ActivationLease,
  PlanIdentity,
} from "@opensesame/capability-composition";
import { describe, expect, it } from "vitest";
import {
  assertLeaseCurrent,
  deriveLease,
  leaseIsCurrent,
  mintLease,
} from "./lease.js";
import { CapabilityDenied } from "./runtime-contract.js";

const IDENTITY: PlanIdentity = {
  instanceId: "instance",
  installationId: "installation",
  vaultId: null,
  distributionId: "distribution",
  policyRevision: "r1",
  selectionRevision: "s1",
  planDigest: `sha256:${"0".repeat(64)}`,
};

describe("LIFE-02: a generation bump invalidates every lease of the previous one", () => {
  it("is current for its own generation and stale for any other", () => {
    const { lease } = mintLease(IDENTITY, 4);
    expect(leaseIsCurrent(lease, 4)).toBe(true);
    expect(leaseIsCurrent(lease, 5)).toBe(false);
    expect(leaseIsCurrent(lease, 3)).toBe(false);
    expect(() => assertLeaseCurrent(lease, 5, "vault.passkey-records")).toThrow(
      CapabilityDenied,
    );
  });
});

describe("revocation", () => {
  it("abort is idempotent and leaves the lease stale", () => {
    const minted = mintLease(IDENTITY, 1);
    minted.abort("revoked");
    minted.abort("again");
    expect(minted.lease.signal.aborted).toBe(true);
    expect(minted.lease.signal.reason).toBe("revoked");
    expect(leaseIsCurrent(minted.lease, 1)).toBe(false);
  });

  it("a derived lease falls with its parent, even one already aborted", () => {
    const parent = mintLease(IDENTITY, 2);
    const child = deriveLease(parent.lease);
    expect(leaseIsCurrent(child.lease, 2)).toBe(true);
    parent.abort("commit");
    expect(leaseIsCurrent(child.lease, 2)).toBe(false);
    expect(deriveLease(parent.lease).lease.signal.aborted).toBe(true);
  });

  it("aborting a derived lease leaves its parent and siblings standing", () => {
    const parent = mintLease(IDENTITY, 2);
    const one = deriveLease(parent.lease);
    const two = deriveLease(parent.lease);
    one.abort("activation failed");
    expect(leaseIsCurrent(parent.lease, 2)).toBe(true);
    expect(leaseIsCurrent(two.lease, 2)).toBe(true);
  });
});

describe("only a minted lease counts (#470's gate bound to issued leases)", () => {
  it("an object carrying the current generation and a fresh signal is refused", () => {
    const forged: ActivationLease = Object.freeze({
      identity: IDENTITY,
      generation: 7,
      signal: new AbortController().signal,
    });
    expect(leaseIsCurrent(forged, 7)).toBe(false);
    expect(() => assertLeaseCurrent(forged, 7, "wallet.spending")).toThrow(
      CapabilityDenied,
    );
  });

  it("deriving from a forged lease does not launder it", () => {
    const forged: ActivationLease = Object.freeze({
      identity: IDENTITY,
      generation: 7,
      signal: new AbortController().signal,
    });
    const child = deriveLease(forged).lease;
    expect(child.signal.aborted).toBe(true);
    expect(leaseIsCurrent(child, 7)).toBe(false);
  });

  it("a copy of a real lease is refused too", () => {
    const { lease } = mintLease(IDENTITY, 7);
    expect(leaseIsCurrent({ ...lease }, 7)).toBe(false);
  });
});
