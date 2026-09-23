/** @vitest-environment node */
/**
 * RECOVERY-F — reconstruct + adversarial cases for custodial recovery.
 */
import { describe, expect, it } from "vitest";
import {
  ApprovalQuorumLedger,
  type CustodyGrant,
  LocalShareMaterialGuard,
  type RecoveryRequest,
  type ShareEnvelope,
  assertOutsideCompartmentCustody,
  authorizeReenrollment,
  combineRecoveryShares,
  countIndependentApprovers,
  countIndependentCustodians,
  createGenerationRegistry,
  digestRecoveryRequest,
  issueTargetDeviceChallenge,
  proveTargetDevice,
  reconstructAfterQuorum,
  replaceKeyCustodian,
  reportApprovalQuorum,
  revokeGeneration,
  roleAllows,
  rotateGeneration,
  runAvailabilityDrill,
  sealApproval,
  splitRecoverySecret,
} from "./custody.js";

function macKeys() {
  return {
    shareMac: crypto.getRandomValues(new Uint8Array(32)),
    approvalMac: crypto.getRandomValues(new Uint8Array(32)),
    deviceMac: crypto.getRandomValues(new Uint8Array(32)),
  };
}

async function mintRequest(
  overrides: Partial<Omit<RecoveryRequest, "digest">> = {},
): Promise<RecoveryRequest> {
  const base = {
    requestId: "req-1",
    incidentIds: ["inc-1"] as const,
    vaultRef: "v1",
    compartmentRefs: ["c-outside"] as const,
    targetDeviceBinding: "device-target",
    ephemeralRecipientKeyB64: btoa("ephemeral-recipient-key-32b!!!!!!!!"),
    policyRevision: 1,
    keyEpoch: 1,
    recoveryGeneration: 1,
    nonce: "nonce-1",
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
    ...overrides,
  };
  const digest = await digestRecoveryRequest(base);
  return { ...base, digest };
}

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
