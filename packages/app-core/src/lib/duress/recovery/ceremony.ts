/**
 * RECOVERY-D/E — reconstruction ceremony, re-enrollment, rotation, drills.
 * Approval quorum success is distinct from key-recovery success.
 */

import type { RecoveryRequest } from "./approval.js";
import type { ApprovalQuorumLedger } from "./approval.js";
import { wipe } from "./bytes.js";
import type { CustodyGrant } from "./roles.js";
import { roleAllows } from "./roles.js";
import {
  type LocalShareMaterialGuard,
  type ShareEnvelope,
  combineRecoveryShares,
  splitRecoverySecret,
} from "./shares.js";

export type CeremonyResult =
  | {
      kind: "approval_quorum_met";
      requestDigest: string;
      independentApprovers: number;
      /** Never includes key material. */
      wrappingSecret: null;
    }
  | {
      kind: "key_reconstructed";
      generation: number;
      wrappingSecret: Uint8Array;
    }
  | {
      kind: "reenroll_authorized";
      newGeneration: number;
      newShares: ShareEnvelope[];
    }
  | {
      kind: "drill_passed";
      reconstructed: true;
      armed: false;
    }
  | { kind: "failed"; reason: string };

export type GenerationRegistry = {
  current: number;
  revoked: Set<number>;
};

export function createGenerationRegistry(start = 1): GenerationRegistry {
  return { current: start, revoked: new Set() };
}

export function revokeGeneration(
  reg: GenerationRegistry,
  generation: number,
): void {
  if (generation === reg.current) {
    throw new Error(
      "unsupported_factor: cannot revoke current generation without rotate",
    );
  }
  reg.revoked.add(generation);
}

export function rotateGeneration(reg: GenerationRegistry): number {
  reg.revoked.add(reg.current);
  reg.current += 1;
  return reg.current;
}

export function assertGenerationLive(
  reg: GenerationRegistry,
  generation: number,
): void {
  if (reg.revoked.has(generation)) {
    throw new Error("retired_device: recovery generation revoked");
  }
  if (generation !== reg.current) {
    throw new Error("mixed_generations: not current recovery generation");
  }
}

/**
 * Reconstruct only after approval quorum is met (when required) and shares verify.
 * Does not treat approval alone as key recovery.
 */
export async function reconstructAfterQuorum(input: {
  ledger: ApprovalQuorumLedger;
  request: RecoveryRequest;
  shares: ShareEnvelope[];
  macKey: Uint8Array;
  requireQuorum: boolean;
  registry: GenerationRegistry;
}): Promise<CeremonyResult> {
  try {
    assertGenerationLive(input.registry, input.request.recoveryGeneration);
    if (input.requireQuorum && !input.ledger.quorumMet(input.request.digest)) {
      return {
        kind: "failed",
        reason: "recovery_required: approval quorum not met",
      };
    }
    // Approvals never yield key bytes.
    if (input.ledger.keyMaterialFromApprovals() !== null) {
      return {
        kind: "failed",
        reason: "authority_mismatch: approvals leaked key",
      };
    }
    const wrappingSecret = await combineRecoveryShares({
      shares: input.shares,
      macKey: input.macKey,
      expect: {
        generation: input.request.recoveryGeneration,
        vaultRef: input.request.vaultRef,
        compartmentRef: input.request.compartmentRefs[0] ?? "",
        policyRevision: input.request.policyRevision,
        keyEpoch: input.request.keyEpoch,
        threshold: input.shares[0]?.threshold ?? 2,
      },
    });
    return {
      kind: "key_reconstructed",
      generation: input.request.recoveryGeneration,
      wrappingSecret,
    };
  } catch (err) {
    return {
      kind: "failed",
      reason: err instanceof Error ? err.message : "reconstruct_failed",
    };
  }
}

export function reportApprovalQuorum(
  ledger: ApprovalQuorumLedger,
  requestDigest: string,
  independentApprovers: number,
): CeremonyResult {
  if (!ledger.quorumMet(requestDigest)) {
    return {
      kind: "failed",
      reason: "recovery_required: approval quorum not met",
    };
  }
  return {
    kind: "approval_quorum_met",
    requestDigest,
    independentApprovers,
    wrappingSecret: null,
  };
}

/**
 * Owner-authorized re-enrollment: rotate generation, revoke old, mint new shares.
 * Old plaintext shares must not remain staged above the local guard.
 */
export async function authorizeReenrollment(input: {
  owner: CustodyGrant;
  registry: GenerationRegistry;
  secret: Uint8Array;
  threshold: number;
  total: number;
  vaultRef: string;
  compartmentRef: string;
  policyRevision: number;
  keyEpoch: number;
  macKey: Uint8Array;
  localGuard: LocalShareMaterialGuard;
}): Promise<CeremonyResult> {
  if (!roleAllows(input.owner, "authorize_reenroll")) {
    return {
      kind: "failed",
      reason: "authority_mismatch: affected owner required for re-enrollment",
    };
  }
  input.localGuard.clear();
  const newGeneration = rotateGeneration(input.registry);
  const newShares = await splitRecoverySecret({
    secret: input.secret,
    threshold: input.threshold,
    total: input.total,
    generation: newGeneration,
    vaultRef: input.vaultRef,
    compartmentRef: input.compartmentRef,
    policyRevision: input.policyRevision,
    keyEpoch: input.keyEpoch,
    macKey: input.macKey,
  });
  wipe(input.secret);
  return { kind: "reenroll_authorized", newGeneration, newShares };
}

/**
 * Availability drill: real reconstruct path, never arms production effects.
 */
export async function runAvailabilityDrill(input: {
  shares: ShareEnvelope[];
  macKey: Uint8Array;
  expect: {
    generation: number;
    vaultRef: string;
    compartmentRef: string;
    policyRevision: number;
    keyEpoch: number;
    threshold: number;
  };
}): Promise<CeremonyResult> {
  try {
    const secret = await combineRecoveryShares({
      shares: input.shares,
      macKey: input.macKey,
      expect: input.expect,
    });
    wipe(secret);
    return { kind: "drill_passed", reconstructed: true, armed: false };
  } catch (err) {
    return {
      kind: "failed",
      reason: err instanceof Error ? err.message : "drill_failed",
    };
  }
}

/** Replace a revoked key custodian grant (generation must already be rotated). */
export function replaceKeyCustodian(input: {
  grants: CustodyGrant[];
  revokePrincipalRef: string;
  replacement: CustodyGrant;
  registry: GenerationRegistry;
}): CustodyGrant[] {
  if (input.replacement.role !== "key_custodian") {
    throw new Error("authority_mismatch: replacement must be key_custodian");
  }
  if (input.replacement.generation !== input.registry.current) {
    throw new Error(
      "mixed_generations: replacement must use current generation",
    );
  }
  return input.grants
    .map((g) => {
      if (
        g.principalRef === input.revokePrincipalRef &&
        g.role === "key_custodian"
      ) {
        return { ...g, revoked: true };
      }
      return g;
    })
    .concat(input.replacement);
}
