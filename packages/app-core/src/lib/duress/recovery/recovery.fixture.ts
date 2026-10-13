/**
 * A recovery request, its approvers and a target device, for the RECOVERY-B
 * and RECOVERY-D/E tests.
 */
import {
  type ApproverRegistry,
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
  scopeRef = "v1",
): CustodyGrant => ({
  principalRef,
  role,
  custodyDomain,
  scopeRef,
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

export type Keys = Readonly<{
  device: Uint8Array;
  macKeyFor: (principalRef: string) => Uint8Array;
  registry: ApproverRegistry;
}>;

/** Per-approver MAC keys so one signer cannot satisfy a multi-domain quorum. */
export const keys = (): Keys => {
  const device = key();
  const macByPrincipal = new Map<string, Uint8Array>();
  const macKeyFor = (principalRef: string): Uint8Array => {
    const existing = macByPrincipal.get(principalRef);
    if (existing) return existing;
    const fresh = key();
    macByPrincipal.set(principalRef, fresh);
    return fresh;
  };
  const registry: ApproverRegistry = {
    grants: (request) => {
      const row = (principalRef: string, custodyDomain: string): CustodyGrant =>
        grant(
          "recovery_approver",
          principalRef,
          custodyDomain,
          request.recoveryGeneration,
          request.vaultRef,
        );
      return [
        row("a1", "phone"),
        row("a1", "hardware-token"),
        row("a2", "hardware-token"),
        row("a1", "icloud-sync"),
        row("a2", "icloud-sync"),
        row("someone-else", "phone"),
      ];
    },
    approvalMacKey: (approverRef) => macByPrincipal.get(approverRef),
  };
  return { device, macKeyFor, registry };
};

/** One approver's approval of `request`, with the challenge it answered. */
export async function approve(
  request: RecoveryRequest,
  approver: CustodyGrant,
  secrets: Keys,
  id = `ap-${approver.principalRef}`,
  approvalMacKey?: Uint8Array,
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
    approvalMacKey: approvalMacKey ?? secrets.macKeyFor(approver.principalRef),
    nowMs: NOW,
  });
  return { approval, challenge };
}
