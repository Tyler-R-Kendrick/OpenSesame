/**
 * Hold passkey UV/PRF evidence between ceremony and complete-code submit.
 * Does not unwrap the protected root (INV-03 / INV-04).
 */

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
  clearPasskeyDuressEvidence();
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
}
