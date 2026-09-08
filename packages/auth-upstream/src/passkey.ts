import { DomainError } from "@opensesame/os-domain";

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
  /**
   * Which kind of challenge the caller minted and is willing to spend.
   *
   * Omitted means `"authentication"`, so the plain sign-in path keeps its
   * existing meaning and a caller who does not think about this gets the
   * narrow answer rather than the broad one.
   *
   * It exists because a challenge minted to approve one authorization
   * transaction must not be redeemable as a generic second factor. Both
   * assertions prove the same momentary fact — this person, this
   * authenticator, just now — so nothing in the signature distinguishes them;
   * only the purpose the challenge was issued under does, and a verifier that
   * accepts either lets a page mint an approval ceremony, have the person
   * touch their key for something harmless-looking, and redeem the result as
   * a login.
   */
  expectedPurpose?: string;
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

function isBooleanOutcome(
  value: boolean | PasskeyVerifyResult,
): value is boolean {
  return value === true || value === false;
}

export interface PasskeySeam {
  register(
    principalId: string,
    credential: Omit<PasskeyCredential, "principalId">,
  ): Promise<PasskeyCredential>;
  verify(
    assertion: PasskeyAssertion,
  ): Promise<{ ok: true; principalId: string } | { ok: false }>;
}

export interface PasskeyCredentialStore {
  get(id: string): Promise<PasskeyCredential | undefined>;
  create(record: PasskeyCredential): Promise<boolean>;
  advance(id: string, counter: number): Promise<boolean>;
}

export function createMemoryPasskeyCredentialStore(): PasskeyCredentialStore {
  const credentials = new Map<string, PasskeyCredential>();
  return {
    get: async (id) => credentials.get(id),
    create: async (record) => {
      if (credentials.has(record.credentialId)) return false;
      credentials.set(record.credentialId, record);
      return true;
    },
    advance: async (id, counter) => {
      const current = credentials.get(id);
      if (!current) return false;
      if (counter === 0) return current.counter === 0;
      if (counter <= current.counter) return false;
      credentials.set(id, { ...current, counter });
      return true;
    },
  };
}

export function createPasskeySeam(options?: {
  verifyAssertion?: PasskeyVerifyFn;
  credentialStore?: PasskeyCredentialStore;
}): PasskeySeam {
  const credentials =
    options?.credentialStore ?? createMemoryPasskeyCredentialStore();
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
      if (!(await credentials.create(record))) {
        throw new DomainError(
          "CONFLICT",
          "Passkey credential already registered",
        );
      }
      return record;
    },
    async verify(assertion) {
      const credential = await credentials.get(assertion.credentialId);
      if (!credential) return { ok: false };
      const outcome = await verifyAssertion(assertion, credential);
      const result: PasskeyVerifyResult =
        // The verifier contract returns either a boolean or its structured result.
        isBooleanOutcome(outcome) ? { ok: outcome } : outcome;
      if (!result.ok) return { ok: false };

      const next = result.newCounter;
      if (next !== undefined) {
        if (!Number.isSafeInteger(next) || next < 0) return { ok: false };
        // A counter that fails to advance means the credential was cloned (or an
        // assertion is being replayed): refuse and keep the stored value.
        // The verifier awaited; another assertion may have advanced the counter.
        if (!(await credentials.advance(credential.credentialId, next)))
          return { ok: false };
      }
      return { ok: true, principalId: credential.principalId };
    },
  };
}
