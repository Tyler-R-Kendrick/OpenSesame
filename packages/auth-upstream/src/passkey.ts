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

export type PasskeyVerifyFn = (
  assertion: PasskeyAssertion,
  credential: PasskeyCredential,
) => Promise<boolean>;

export interface PasskeySeam {
  register(
    principalId: string,
    credential: Omit<PasskeyCredential, "principalId">,
  ): Promise<PasskeyCredential>;
  verify(assertion: PasskeyAssertion): Promise<{ ok: true; principalId: string } | { ok: false }>;
}

export function createPasskeySeam(options?: {
  verifyAssertion?: PasskeyVerifyFn;
}): PasskeySeam {
  const credentials = new Map<string, PasskeyCredential>();
  const verifyAssertion: PasskeyVerifyFn =
    options?.verifyAssertion ??
    (async () => {
      throw new Error("Passkey verify not configured — inject verifyAssertion for tests/prod");
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
      const ok = await verifyAssertion(assertion, credential);
      if (!ok) return { ok: false };
      return { ok: true, principalId: credential.principalId };
    },
  };
}
