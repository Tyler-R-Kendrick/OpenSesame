/**
 * RECOVERY-B — request-digest-bound approval quorums.
 * Separate from key custody: meeting quorum does not reconstruct wrapping secrets.
 */

import { b64, fromB64, hex, timingSafeEqual } from "./bytes.js";
import type { CustodyGrant } from "./roles.js";
import { roleAllows } from "./roles.js";

export type RecoveryRequest = Readonly<{
  requestId: string;
  incidentIds: readonly string[];
  vaultRef: string;
  compartmentRefs: readonly string[];
  targetDeviceBinding: string;
  ephemeralRecipientKeyB64: string;
  policyRevision: number;
  keyEpoch: number;
  recoveryGeneration: number;
  nonce: string;
  expiresAt: string;
  digest: string;
}>;

export type TargetDeviceChallenge = Readonly<{
  challengeId: string;
  targetDeviceBinding: string;
  nonce: string;
  issuedAt: string;
  expiresAt: string;
}>;

export type TargetDeviceProof = Readonly<{
  challengeId: string;
  targetDeviceBinding: string;
  nonce: string;
  proofMacB64: string;
  provenAt: string;
}>;

export type RecoveryApproval = Readonly<{
  approvalId: string;
  requestDigest: string;
  approverRef: string;
  custodyDomain: string;
  targetDeviceProof: TargetDeviceProof;
  nonce: string;
  issuedAt: string;
  macB64: string;
}>;

export type QuorumConfig = Readonly<{
  thresholdK: number;
  /** Wall-clock skew allowance for proof freshness (ms). */
  proofMaxAgeMs: number;
}>;

export type ApprovalOutcome =
  | {
      kind: "approval_accepted";
      independentApprovers: number;
      quorumMet: boolean;
    }
  | { kind: "approval_rejected"; reason: string };

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const dig = await crypto.subtle.digest("SHA-256", bytes);
  return hex(new Uint8Array(dig));
}

async function hmacB64(key: Uint8Array, msg: Uint8Array): Promise<string> {
  const ck = await crypto.subtle.importKey(
    "raw",
    key,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return b64(new Uint8Array(await crypto.subtle.sign("HMAC", ck, msg)));
}

export async function digestRecoveryRequest(
  req: Omit<RecoveryRequest, "digest">,
): Promise<string> {
  const body = new TextEncoder().encode(
    JSON.stringify({
      requestId: req.requestId,
      incidentIds: [...req.incidentIds],
      vaultRef: req.vaultRef,
      compartmentRefs: [...req.compartmentRefs],
      targetDeviceBinding: req.targetDeviceBinding,
      ephemeralRecipientKeyB64: req.ephemeralRecipientKeyB64,
      policyRevision: req.policyRevision,
      keyEpoch: req.keyEpoch,
      recoveryGeneration: req.recoveryGeneration,
      nonce: req.nonce,
      expiresAt: req.expiresAt,
    }),
  );
  return sha256Hex(body);
}

export function issueTargetDeviceChallenge(input: {
  targetDeviceBinding: string;
  nowMs?: number;
  ttlMs?: number;
}): TargetDeviceChallenge {
  const now = input.nowMs ?? Date.now();
  const ttl = input.ttlMs ?? 120_000;
  const nonceBytes = crypto.getRandomValues(new Uint8Array(16));
  return {
    challengeId: b64(crypto.getRandomValues(new Uint8Array(12))),
    targetDeviceBinding: input.targetDeviceBinding,
    nonce: b64(nonceBytes),
    issuedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + ttl).toISOString(),
  };
}

/** Prove possession of the enrolled target-device MAC key for a fresh challenge. */
export async function proveTargetDevice(input: {
  challenge: TargetDeviceChallenge;
  deviceMacKey: Uint8Array;
  nowMs?: number;
}): Promise<TargetDeviceProof> {
  const now = input.nowMs ?? Date.now();
  if (Date.parse(input.challenge.expiresAt) < now) {
    throw new Error("stale_session: target device challenge expired");
  }
  const msg = new TextEncoder().encode(
    JSON.stringify({
      challengeId: input.challenge.challengeId,
      targetDeviceBinding: input.challenge.targetDeviceBinding,
      nonce: input.challenge.nonce,
    }),
  );
  return {
    challengeId: input.challenge.challengeId,
    targetDeviceBinding: input.challenge.targetDeviceBinding,
    nonce: input.challenge.nonce,
    proofMacB64: await hmacB64(input.deviceMacKey, msg),
    provenAt: new Date(now).toISOString(),
  };
}

export type VerifyTargetDeviceProofInput = Readonly<{
  proof: TargetDeviceProof;
  expectedDeviceBinding: string;
  deviceMacKey: Uint8Array;
  challenge: TargetDeviceChallenge;
  nowMs?: number;
  maxAgeMs: number;
}>;

export async function verifyTargetDeviceProof(
  input: VerifyTargetDeviceProofInput,
): Promise<void> {
  const now = input.nowMs ?? Date.now();
  if (input.proof.targetDeviceBinding !== input.expectedDeviceBinding) {
    throw new Error("scope_mismatch: target device binding");
  }
  if (input.proof.challengeId !== input.challenge.challengeId) {
    throw new Error("stale_session: challenge mismatch");
  }
  if (input.proof.nonce !== input.challenge.nonce) {
    throw new Error("stale_session: challenge nonce mismatch");
  }
  if (Date.parse(input.challenge.expiresAt) < now) {
    throw new Error("stale_session: challenge expired");
  }
  const provenAt = Date.parse(input.proof.provenAt);
  if (Number.isNaN(provenAt) || now - provenAt > input.maxAgeMs) {
    throw new Error("stale_session: target device proof not fresh");
  }
  const msg = new TextEncoder().encode(
    JSON.stringify({
      challengeId: input.challenge.challengeId,
      targetDeviceBinding: input.challenge.targetDeviceBinding,
      nonce: input.challenge.nonce,
    }),
  );
  const expected = await hmacB64(input.deviceMacKey, msg);
  if (!timingSafeEqual(fromB64(expected), fromB64(input.proof.proofMacB64))) {
    throw new Error("authority_mismatch: target device proof");
  }
}

export async function sealApproval(input: {
  approvalId: string;
  request: RecoveryRequest;
  approver: CustodyGrant;
  targetDeviceProof: TargetDeviceProof;
  approvalMacKey: Uint8Array;
  nowMs?: number;
}): Promise<RecoveryApproval> {
  if (!roleAllows(input.approver, "approve_recovery")) {
    throw new Error("authority_mismatch: not a recovery approver");
  }
  const now = input.nowMs ?? Date.now();
  if (Date.parse(input.request.expiresAt) < now) {
    throw new Error("expired: recovery request");
  }
  const digest = await digestRecoveryRequest({
    requestId: input.request.requestId,
    incidentIds: input.request.incidentIds,
    vaultRef: input.request.vaultRef,
    compartmentRefs: input.request.compartmentRefs,
    targetDeviceBinding: input.request.targetDeviceBinding,
    ephemeralRecipientKeyB64: input.request.ephemeralRecipientKeyB64,
    policyRevision: input.request.policyRevision,
    keyEpoch: input.request.keyEpoch,
    recoveryGeneration: input.request.recoveryGeneration,
    nonce: input.request.nonce,
    expiresAt: input.request.expiresAt,
  });
  if (digest !== input.request.digest) {
    throw new Error("authority_mismatch: request digest");
  }
  const nonce = b64(crypto.getRandomValues(new Uint8Array(16)));
  const body = {
    approvalId: input.approvalId,
    requestDigest: digest,
    approverRef: input.approver.principalRef,
    custodyDomain: input.approver.custodyDomain,
    targetDeviceProof: input.targetDeviceProof,
    nonce,
    issuedAt: new Date(now).toISOString(),
  };
  const macB64 = await hmacB64(
    input.approvalMacKey,
    new TextEncoder().encode(JSON.stringify(body)),
  );
  return { ...body, macB64 };
}

/**
 * Ledger for non-reusable approvals. Quorum success ≠ key reconstruction.
 */
export class ApprovalQuorumLedger {
  private readonly usedApprovalIds = new Set<string>();
  private readonly usedNonces = new Set<string>();
  private readonly usedChallengeIds = new Set<string>();
  private readonly acceptedByDigest = new Map<string, RecoveryApproval[]>();

  constructor(
    private readonly approvalMacKey: Uint8Array,
    private readonly deviceMacKey: Uint8Array,
    private readonly config: QuorumConfig,
  ) {}

  async submit(input: {
    approval: RecoveryApproval;
    request: RecoveryRequest;
    challenge: TargetDeviceChallenge;
    nowMs?: number;
  }): Promise<ApprovalOutcome> {
    const { approval, request, challenge } = input;
    const now = input.nowMs ?? Date.now();

    try {
      if (this.usedApprovalIds.has(approval.approvalId)) {
        throw new Error("replay: approval already used");
      }
      if (this.usedNonces.has(approval.nonce)) {
        throw new Error("replay: approval nonce already used");
      }
      if (this.usedChallengeIds.has(approval.targetDeviceProof.challengeId)) {
        throw new Error("replay: target device challenge already consumed");
      }
      if (approval.requestDigest !== request.digest) {
        throw new Error(
          "authority_mismatch: approval not bound to request digest",
        );
      }
      const recomputed = await digestRecoveryRequest({
        requestId: request.requestId,
        incidentIds: request.incidentIds,
        vaultRef: request.vaultRef,
        compartmentRefs: request.compartmentRefs,
        targetDeviceBinding: request.targetDeviceBinding,
        ephemeralRecipientKeyB64: request.ephemeralRecipientKeyB64,
        policyRevision: request.policyRevision,
        keyEpoch: request.keyEpoch,
        recoveryGeneration: request.recoveryGeneration,
        nonce: request.nonce,
        expiresAt: request.expiresAt,
      });
      if (recomputed !== request.digest) {
        throw new Error("authority_mismatch: request digest");
      }
      if (Date.parse(request.expiresAt) < now) {
        throw new Error("expired: recovery request");
      }

      await verifyTargetDeviceProof({
        proof: approval.targetDeviceProof,
        expectedDeviceBinding: request.targetDeviceBinding,
        deviceMacKey: this.deviceMacKey,
        challenge,
        nowMs: now,
        maxAgeMs: this.config.proofMaxAgeMs,
      } satisfies VerifyTargetDeviceProofInput);

      const body = {
        approvalId: approval.approvalId,
        requestDigest: approval.requestDigest,
        approverRef: approval.approverRef,
        custodyDomain: approval.custodyDomain,
        targetDeviceProof: approval.targetDeviceProof,
        nonce: approval.nonce,
        issuedAt: approval.issuedAt,
      };
      const expectedMac = await hmacB64(
        this.approvalMacKey,
        new TextEncoder().encode(JSON.stringify(body)),
      );
      if (!timingSafeEqual(fromB64(expectedMac), fromB64(approval.macB64))) {
        throw new Error("tampered_approval");
      }

      this.usedApprovalIds.add(approval.approvalId);
      this.usedNonces.add(approval.nonce);
      this.usedChallengeIds.add(approval.targetDeviceProof.challengeId);

      const list = this.acceptedByDigest.get(request.digest) ?? [];
      // One approval per custody domain per request
      if (list.some((a) => a.custodyDomain === approval.custodyDomain)) {
        throw new Error("duplicate_custody_domain: approval already counted");
      }
      list.push(approval);
      this.acceptedByDigest.set(request.digest, list);

      const independentApprovers = new Set(list.map((a) => a.custodyDomain))
        .size;
      return {
        kind: "approval_accepted",
        independentApprovers,
        quorumMet: independentApprovers >= this.config.thresholdK,
      };
    } catch (err) {
      return {
        kind: "approval_rejected",
        reason: err instanceof Error ? err.message : "approval_rejected",
      };
    }
  }

  quorumMet(requestDigest: string): boolean {
    const list = this.acceptedByDigest.get(requestDigest) ?? [];
    return (
      new Set(list.map((a) => a.custodyDomain)).size >= this.config.thresholdK
    );
  }

  /** Explicit: approval quorum never yields key material. */
  keyMaterialFromApprovals(): null {
    return null;
  }
}
