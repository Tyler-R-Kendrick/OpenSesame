/**
 * Hold passkey UV/PRF evidence between ceremony and complete-code submit.
 * Does not unwrap the protected root (INV-03 / INV-04).
 */

export type PasskeyDuressEvidence = Readonly<{
  userVerified: boolean;
  prfOutput: Uint8Array | null;
  credentialIdB64?: string;
  origin?: string;
}>;

type MutablePasskeyDuressEvidence = {
  userVerified: boolean;
  prfOutput: Uint8Array | null;
  credentialIdB64?: string;
  origin?: string;
};

let pending: PasskeyDuressEvidence | null = null;

export function stashPasskeyDuressEvidence(
  evidence: PasskeyDuressEvidence,
): void {
  clearPasskeyDuressEvidence();
  const next = {
    userVerified: evidence.userVerified,
    prfOutput: evidence.prfOutput ? new Uint8Array(evidence.prfOutput) : null,
  } satisfies MutablePasskeyDuressEvidence;
  const stamped: MutablePasskeyDuressEvidence = { ...next };
  if (evidence.credentialIdB64 !== undefined) {
    stamped.credentialIdB64 = evidence.credentialIdB64;
  }
  if (evidence.origin !== undefined) {
    stamped.origin = evidence.origin;
  }
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
}
