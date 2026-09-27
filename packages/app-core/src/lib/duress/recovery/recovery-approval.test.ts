/** @vitest-environment node */
/**
 * RECOVERY-B — an approval counts once, for one request, from one custody
 * domain, only with a fresh proof from the target device; and a quorum of
 * approvals never yields key material.
 */
import { describe, expect, it } from "vitest";
import {
  ApprovalQuorumLedger,
  issueTargetDeviceChallenge,
  proveTargetDevice,
  sealApproval,
  verifyTargetDeviceProof,
} from "./approval.js";
import {
  DEVICE,
  NOW,
  approve,
  grant,
  key,
  keys,
  recoveryRequest,
} from "./recovery.fixture.js";

const config = { thresholdK: 2, proofMaxAgeMs: 60_000 };

describe("sealApproval", () => {
  it("is refused to anyone but a live recovery approver", async () => {
    const request = await recoveryRequest();
    const secrets = keys();
    for (const approver of [
      grant("key_custodian", "k1", "phone"),
      grant("affected_owner", "o1", "phone"),
      { ...grant("recovery_approver", "a1", "phone"), revoked: true },
    ]) {
      await expect(approve(request, approver, secrets)).rejects.toThrow(
        /not a recovery approver/,
      );
    }
  });

  it("is refused for an expired request or one edited after its digest", async () => {
    const secrets = keys();
    const approver = grant("recovery_approver", "a1", "phone");
    const expired = await recoveryRequest({
      expiresAt: new Date(NOW - 1).toISOString(),
    });
    await expect(approve(expired, approver, secrets)).rejects.toThrow(
      /expired/,
    );
    const edited = { ...(await recoveryRequest()), vaultRef: "v-other" };
    await expect(approve(edited, approver, secrets)).rejects.toThrow(
      /request digest/,
    );
  });
});

describe("target device proof", () => {
  it("cannot be made for an expired challenge", async () => {
    const challenge = issueTargetDeviceChallenge({
      targetDeviceBinding: DEVICE,
      nowMs: NOW,
      ttlMs: 1000,
    });
    await expect(
      proveTargetDevice({ challenge, deviceMacKey: key(), nowMs: NOW + 2000 }),
    ).rejects.toThrow(/challenge expired/);
  });

  it("verifies only for its device, its challenge, fresh, under the device key", async () => {
    const deviceMacKey = key();
    const challenge = issueTargetDeviceChallenge({
      targetDeviceBinding: DEVICE,
      nowMs: NOW,
    });
    const proof = await proveTargetDevice({
      challenge,
      deviceMacKey,
      nowMs: NOW,
    });
    const base = {
      proof,
      expectedDeviceBinding: DEVICE,
      deviceMacKey,
      challenge,
      nowMs: NOW,
      maxAgeMs: 60_000,
    };
    await expect(verifyTargetDeviceProof(base)).resolves.toBeUndefined();
    const other = issueTargetDeviceChallenge({
      targetDeviceBinding: DEVICE,
      nowMs: NOW,
    });
    const cases: [Partial<typeof base>, RegExp][] = [
      [{ expectedDeviceBinding: "device:other" }, /target device binding/],
      [{ challenge: other }, /challenge mismatch/],
      [{ challenge: { ...challenge, nonce: other.nonce } }, /nonce mismatch/],
      [{ nowMs: NOW + 130_000, maxAgeMs: 1e9 }, /challenge expired/],
      [{ nowMs: NOW + 61_000 }, /not fresh/],
      [{ proof: { ...proof, provenAt: "not a date" } }, /not fresh/],
      [{ deviceMacKey: key() }, /target device proof/],
    ];
    for (const [change, reason] of cases) {
      await expect(
        verifyTargetDeviceProof({ ...base, ...change }),
      ).rejects.toThrow(reason);
    }
  });
});

describe("ApprovalQuorumLedger", () => {
  it("meets quorum at K independent custody domains, and yields no key", async () => {
    const secrets = keys();
    const request = await recoveryRequest();
    const ledger = new ApprovalQuorumLedger(
      secrets.approval,
      secrets.device,
      config,
    );
    const first = await approve(
      request,
      grant("recovery_approver", "a1", "phone"),
      secrets,
    );
    expect(await ledger.submit({ ...first, request, nowMs: NOW })).toEqual({
      kind: "approval_accepted",
      independentApprovers: 1,
      quorumMet: false,
    });
    expect(ledger.quorumMet(request.digest)).toBe(false);
    const second = await approve(
      request,
      grant("recovery_approver", "a2", "hardware-token"),
      secrets,
    );
    expect(await ledger.submit({ ...second, request, nowMs: NOW })).toEqual({
      kind: "approval_accepted",
      independentApprovers: 2,
      quorumMet: true,
    });
    expect(ledger.quorumMet(request.digest)).toBe(true);
    expect(ledger.keyMaterialFromApprovals()).toBeNull();
  });

  it("counts two approvers on one synced domain once", async () => {
    const secrets = keys();
    const request = await recoveryRequest();
    const ledger = new ApprovalQuorumLedger(
      secrets.approval,
      secrets.device,
      config,
    );
    const a = await approve(
      request,
      grant("recovery_approver", "a1", "icloud-sync"),
      secrets,
    );
    const b = await approve(
      request,
      grant("recovery_approver", "a2", "icloud-sync"),
      secrets,
    );
    await ledger.submit({ ...a, request, nowMs: NOW });
    expect(await ledger.submit({ ...b, request, nowMs: NOW })).toEqual({
      kind: "approval_rejected",
      reason: "duplicate_custody_domain: approval already counted",
    });
    expect(ledger.quorumMet(request.digest)).toBe(false);
  });

  it("refuses a replayed approval, nonce or device challenge", async () => {
    const secrets = keys();
    const request = await recoveryRequest();
    const ledger = new ApprovalQuorumLedger(
      secrets.approval,
      secrets.device,
      config,
    );
    const once = await approve(
      request,
      grant("recovery_approver", "a1", "phone"),
      secrets,
    );
    await ledger.submit({ ...once, request, nowMs: NOW });
    const replay = await ledger.submit({ ...once, request, nowMs: NOW });
    expect(replay).toMatchObject({ reason: "replay: approval already used" });
    const renamed = await ledger.submit({
      ...once,
      approval: { ...once.approval, approvalId: "fresh-id" },
      request,
      nowMs: NOW,
    });
    expect(renamed).toMatchObject({ reason: /replay: approval nonce/ });
    const sameChallenge = await approve(
      request,
      grant("recovery_approver", "a2", "hardware-token"),
      secrets,
    );
    const reused = await ledger.submit({
      approval: {
        ...sameChallenge.approval,
        targetDeviceProof: once.approval.targetDeviceProof,
      },
      challenge: once.challenge,
      request,
      nowMs: NOW,
    });
    expect(reused).toMatchObject({ reason: /challenge already consumed/ });
  });

  it("refuses an approval for another request, an edited one, or a forged MAC", async () => {
    const secrets = keys();
    const request = await recoveryRequest();
    const other = await recoveryRequest({ requestId: "req-2" });
    const ledger = new ApprovalQuorumLedger(
      secrets.approval,
      secrets.device,
      config,
    );
    const approver = grant("recovery_approver", "a1", "phone");
    const forOther = await approve(other, approver, secrets, "x1");
    expect(
      await ledger.submit({ ...forOther, request, nowMs: NOW }),
    ).toMatchObject({ reason: /not bound to request digest/ });
    const edited = { ...request, compartmentRefs: ["c-else"] };
    const signed = await approve(request, approver, secrets, "x2");
    expect(
      await ledger.submit({ ...signed, request: edited, nowMs: NOW }),
    ).toMatchObject({ reason: "authority_mismatch: request digest" });
    // The right device, but an approval sealed under another MAC key.
    const forged = await approve(
      request,
      approver,
      { ...secrets, approval: key() },
      "x3",
    );
    expect(
      await ledger.submit({ ...forged, request, nowMs: NOW }),
    ).toMatchObject({ reason: "tampered_approval" });
    const tampered = await ledger.submit({
      ...signed,
      approval: { ...signed.approval, approverRef: "someone-else" },
      request,
      nowMs: NOW,
    });
    expect(tampered).toMatchObject({ reason: "tampered_approval" });
    // A refusal consumes nothing: the genuine approval still counts.
    expect(
      await ledger.submit({ ...signed, request, nowMs: NOW }),
    ).toMatchObject({ kind: "approval_accepted" });
  });

  it("refuses an expired request and a stale device proof", async () => {
    const secrets = keys();
    const request = await recoveryRequest();
    const ledger = new ApprovalQuorumLedger(
      secrets.approval,
      secrets.device,
      config,
    );
    const fresh = await approve(
      request,
      grant("recovery_approver", "a1", "phone"),
      secrets,
    );
    expect(
      await ledger.submit({ ...fresh, request, nowMs: NOW + 700_000 }),
    ).toMatchObject({ reason: "expired: recovery request" });
    expect(
      await ledger.submit({ ...fresh, request, nowMs: NOW + 61_000 }),
    ).toMatchObject({ reason: /not fresh/ });
  });

  it("refuses a proof made by a different device", async () => {
    const secrets = keys();
    const request = await recoveryRequest();
    const ledger = new ApprovalQuorumLedger(
      secrets.approval,
      secrets.device,
      config,
    );
    const challenge = issueTargetDeviceChallenge({
      targetDeviceBinding: DEVICE,
      nowMs: NOW,
    });
    const targetDeviceProof = await proveTargetDevice({
      challenge,
      deviceMacKey: key(),
      nowMs: NOW,
    });
    const approval = await sealApproval({
      approvalId: "ap-1",
      request,
      approver: grant("recovery_approver", "a1", "phone"),
      targetDeviceProof,
      approvalMacKey: secrets.approval,
      nowMs: NOW,
    });
    expect(
      await ledger.submit({ approval, challenge, request, nowMs: NOW }),
    ).toMatchObject({ reason: "authority_mismatch: target device proof" });
  });
});
