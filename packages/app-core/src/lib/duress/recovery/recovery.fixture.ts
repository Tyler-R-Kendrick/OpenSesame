/**
 * A recovery request, its approvers and a target device, for the RECOVERY-B
 * and RECOVERY-D/E tests.
 */
import {
  type RecoveryRequest,
  digestRecoveryRequest,
  issueTargetDeviceChallenge,
  proveTargetDevice,
  sealApproval,
} from "./approval.js";
import type { CustodyGrant } from "./roles.js";

export const NOW = Date.parse("2026-09-27T12:00:00.000Z");
export const DEVICE = "device:phone-7";

export const key = (): Uint8Array => crypto.getRandomValues(new Uint8Array(32));

export const grant = (
  role: CustodyGrant["role"],
  principalRef: string,
  custodyDomain: string,
  generation = 1,
): CustodyGrant => ({
  principalRef,
  role,
  custodyDomain,
  scopeRef: "c-outside",
  generation,
});

export async function recoveryRequest(
  overrides: Partial<Omit<RecoveryRequest, "digest">> = {},
): Promise<RecoveryRequest> {
  const body = {
    requestId: "req-1",
    incidentIds: ["inc-1"],
    vaultRef: "v1",
    compartmentRefs: ["c1"],
    targetDeviceBinding: DEVICE,
    ephemeralRecipientKeyB64: "AAAA",
    policyRevision: 3,
    keyEpoch: 2,
    recoveryGeneration: 1,
    nonce: "n-1",
    expiresAt: new Date(NOW + 600_000).toISOString(),
    ...overrides,
  };
  return { ...body, digest: await digestRecoveryRequest(body) };
}

export type Keys = Readonly<{ approval: Uint8Array; device: Uint8Array }>;

export const keys = (): Keys => ({ approval: key(), device: key() });

/** One approver's approval of `request`, with the challenge it answered. */
export async function approve(
  request: RecoveryRequest,
  approver: CustodyGrant,
  secrets: Keys,
  id = `ap-${approver.principalRef}`,
) {
  const challenge = issueTargetDeviceChallenge({
    targetDeviceBinding: request.targetDeviceBinding,
    nowMs: NOW,
  });
  const targetDeviceProof = await proveTargetDevice({
    challenge,
    deviceMacKey: secrets.device,
    nowMs: NOW,
  });
  const approval = await sealApproval({
    approvalId: id,
    request,
    approver,
    targetDeviceProof,
    approvalMacKey: secrets.approval,
    nowMs: NOW,
  });
  return { approval, challenge };
}
