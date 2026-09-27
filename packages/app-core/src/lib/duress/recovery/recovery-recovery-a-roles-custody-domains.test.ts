/** @vitest-environment node */
/**
 * RECOVERY-F — reconstruct + adversarial cases for custodial recovery.
 */
import { describe, expect, it } from "vitest";
import {
  type CustodyGrant,
  assertOutsideCompartmentCustody,
  countIndependentApprovers,
  countIndependentCustodians,
  roleAllows,
} from "./custody.js";

const approver = (
  ref: string,
  domain: string,
  generation = 1,
): CustodyGrant => ({
  principalRef: ref,
  role: "recovery_approver",
  custodyDomain: domain,
  scopeRef: "c-outside",
  generation,
});

const keyCustodian = (
  ref: string,
  domain: string,
  generation = 1,
): CustodyGrant => ({
  principalRef: ref,
  role: "key_custodian",
  custodyDomain: domain,
  scopeRef: "c-outside",
  generation,
});

describe("RECOVERY-A roles + custody domains", () => {
  it("separates alert / lock / approver / key / owner capabilities", () => {
    const alert: CustodyGrant = {
      principalRef: "a",
      role: "alert_recipient",
      custodyDomain: "phone",
      scopeRef: "c1",
      generation: 1,
    };
    expect(roleAllows(alert, "acknowledge_alert")).toBe(true);
    expect(roleAllows(alert, "approve_recovery")).toBe(false);
    expect(roleAllows(alert, "release_share")).toBe(false);

    const lock: CustodyGrant = {
      principalRef: "l",
      role: "lock_custodian",
      custodyDomain: "hw",
      scopeRef: "c1",
      generation: 1,
    };
    expect(roleAllows(lock, "clear_hold")).toBe(true);
    expect(roleAllows(lock, "release_share")).toBe(false);

    expect(roleAllows(keyCustodian("k", "token"), "approve_recovery")).toBe(
      false,
    );
    expect(roleAllows(keyCustodian("k", "token"), "release_share")).toBe(true);

    const owner: CustodyGrant = {
      principalRef: "o",
      role: "affected_owner",
      custodyDomain: "owner",
      scopeRef: "c1",
      generation: 1,
    };
    expect(roleAllows(owner, "authorize_reenroll")).toBe(true);
    expect(roleAllows(owner, "release_share")).toBe(false);
  });

  it("counts synced credentials as one independent custodian domain", () => {
    expect(
      countIndependentCustodians([
        keyCustodian("a", "icloud-sync"),
        keyCustodian("b", "icloud-sync"),
        keyCustodian("c", "yubikey"),
      ]),
    ).toBe(2);
    expect(
      countIndependentApprovers([
        approver("x", "work-laptop"),
        approver("y", "work-laptop"),
      ]),
    ).toBe(1);
  });

  it("rejects circular custody inside removed compartments", () => {
    expect(() =>
      assertOutsideCompartmentCustody({
        keyCustodianScopeRefs: ["c-removed"],
        removedCompartmentRefs: ["c-removed"],
        outsideCompartmentRefs: [],
      }),
    ).toThrow(/circular_recovery/);
    expect(() =>
      assertOutsideCompartmentCustody({
        keyCustodianScopeRefs: ["c-outside"],
        removedCompartmentRefs: ["c-removed"],
        outsideCompartmentRefs: ["c-outside"],
      }),
    ).not.toThrow();
  });
});
