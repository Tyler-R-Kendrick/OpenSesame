import { isBoolean } from "@opensesame/os-domain";
/**
 * Passkey / WebAuthn seam. Production wires Better Auth + SimpleWebAuthn;
 * tests inject `verifyAssertion`.
 */
export interface PasskeyCredential {
  credentialId: string;
  publicKey: Uint8Array;
  counter: number;
  principalId: string;
}

export interface PasskeyAssertion {
  credentialId: string;
  clientDataJSON: Uint8Array;
  authenticatorData: Uint8Array;
  signature: Uint8Array;
}

/**
 * Result of an assertion check. `newCounter` is the authenticator's signature
 * counter from the assertion; the seam persists it so a cloned authenticator
 * replaying an older counter is detected (WebAuthn L2 §7.2 step 21).
 */
export interface PasskeyVerifyResult {
  ok: boolean;
  newCounter?: number;
}

export type PasskeyVerifyFn = (
  assertion: PasskeyAssertion,
  credential: PasskeyCredential,
) => Promise<boolean | PasskeyVerifyResult>;

export interface PasskeySeam {
  register(
    principalId: string,
    credential: Omit<PasskeyCredential, "principalId">,
  ): Promise<PasskeyCredential>;
  verify(
    assertion: PasskeyAssertion,
  ): Promise<{ ok: true; principalId: string } | { ok: false }>;
}

export function createPasskeySeam(options?: {
  verifyAssertion?: PasskeyVerifyFn;
}): PasskeySeam {
  const credentials = new Map<string, PasskeyCredential>();
  const verifyAssertion: PasskeyVerifyFn =
    options?.verifyAssertion ??
    (async () => {
      throw new Error(
        "Passkey verify not configured — inject verifyAssertion for tests/prod",
      );
    });

  return {
    async register(principalId, credential) {
      const record: PasskeyCredential = { ...credential, principalId };
      credentials.set(record.credentialId, record);
      return record;
    },
    async verify(assertion) {
      const credential = credentials.get(assertion.credentialId);
      if (!credential) return { ok: false };
      const outcome = await verifyAssertion(assertion, credential);
      const result: PasskeyVerifyResult =
        isBoolean(outcome) ? { ok: outcome } : outcome;
      if (!result.ok) return { ok: false };

      const next = result.newCounter;
      if (next !== undefined && next !== 0) {
        // A counter that fails to advance means the credential was cloned (or an
        // assertion is being replayed): refuse and keep the stored value.
        if (next <= credential.counter) return { ok: false };
        credentials.set(credential.credentialId, {
          ...credential,
          counter: next,
        });
      }
      return { ok: true, principalId: credential.principalId };
    },
  };
}
