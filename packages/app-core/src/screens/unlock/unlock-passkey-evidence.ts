/**
 * Hold passkey UV/PRF evidence between ceremony and complete-code submit.
 * Does not unwrap the protected root (INV-03 / INV-04).
 */

import type { ProtectorUnlockMethodId } from "../../lib/vault/protection/unlock-protector-methods.js";

type PasskeyDuressEvidenceFields = {
  userVerified: boolean;
  prfOutput: Uint8Array | null;
  credentialIdB64?: string;
  origin?: string;
};

export type PasskeyDuressEvidence = Readonly<PasskeyDuressEvidenceFields>;

let pending: PasskeyDuressEvidence | null = null;

/** Copy optional select fields without writing `undefined` under exactOptional. */
export function toSelectOptions(src: {
  userVerified: boolean;
  prfOutput: Uint8Array | null;
  origin?: string;
  credentialIdB64?: string;
}): PasskeyDuressEvidenceFields {
  const out: PasskeyDuressEvidenceFields = {
    userVerified: src.userVerified,
    prfOutput: src.prfOutput,
  };
  if (src.origin !== undefined) out.origin = src.origin;
  if (src.credentialIdB64 !== undefined) {
    out.credentialIdB64 = src.credentialIdB64;
  }
  return out;
}

export function stashPasskeyDuressEvidence(
  evidence: PasskeyDuressEvidence,
): void {
  // The held protector root belongs to the same ceremony; only the evidence
  // is replaced here.
  if (pending?.prfOutput) pending.prfOutput.fill(0);
  pending = null;
  const stamped = toSelectOptions(evidence);
  if (stamped.prfOutput) stamped.prfOutput = new Uint8Array(stamped.prfOutput);
  pending = stamped;
}

export function takePasskeyDuressEvidence(): PasskeyDuressEvidence | null {
  const out = pending;
  pending = null;
  return out;
}

export function peekPasskeyDuressEvidence(): PasskeyDuressEvidence | null {
  return pending;
}

export function clearPasskeyDuressEvidence(): void {
  if (pending?.prfOutput) pending.prfOutput.fill(0);
  pending = null;
  clearHeldProtectorRoot();
}

/**
 * A root an age-passkey ceremony opened, kept between the tap and the complete
 * code a two-input trigger asks for (ADR 0152). It is the protector road's
 * counterpart of `prfOutput`: held in memory only, zeroed on every clear, and
 * never spent before the code has been routed through TRIGGER.
 */
type HeldProtectorRoot = {
  root: ArrayBuffer;
  method: ProtectorUnlockMethodId;
};

let heldRoot: HeldProtectorRoot | null = null;

export function holdProtectorRoot(
  root: ArrayBuffer,
  method: ProtectorUnlockMethodId,
): void {
  clearHeldProtectorRoot();
  heldRoot = { root, method };
}

export function hasHeldProtectorRoot(): boolean {
  return heldRoot !== null;
}

/** Hand the held root to its one spender; the caller zeroes it. */
export function takeHeldProtectorRoot(): HeldProtectorRoot | null {
  const out = heldRoot;
  heldRoot = null;
  return out;
}

export function clearHeldProtectorRoot(): void {
  if (heldRoot) new Uint8Array(heldRoot.root).fill(0);
  heldRoot = null;
}
