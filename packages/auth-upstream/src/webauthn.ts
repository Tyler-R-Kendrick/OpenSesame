import { isString, overlapCast } from "@opensesame/os-domain";
/**
 * Production WebAuthn registration + assertion via @simplewebauthn/server.
 * Requires a previously issued challenge that matches clientDataJSON.challenge.
 */
import {
  type AuthenticatorTransportFuture,
  type GenerateAuthenticationOptionsOpts,
  generateAuthenticationOptions,
  generateRegistrationOptions,
} from "@simplewebauthn/server";
import type {
  AuthenticationResponseJSON,
  RegistrationResponseJSON,
} from "@simplewebauthn/server";
import type {
  PasskeyAssertion,
  PasskeyCredential,
  PasskeyVerifyFn,
} from "./passkey.js";
import { simpleWebAuthnSeams } from "./simplewebauthn.js";

function toBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

export interface WebAuthnRpConfig {
  rpID: string;
  origin: string;
}

const AUTHENTICATOR_TRANSPORTS: AuthenticatorTransportFuture[] = [
  "internal",
  "hybrid",
  "usb",
  "ble",
  "nfc",
];

export interface PasskeyRegistrationOptionsInput {
  rp: WebAuthnRpConfig;
  rpName: string;
  userId: string;
  userName: string;
  userDisplayName: string;
  excludeCredentialIds?: string[];
  authenticatorAttachment?: "cross-platform" | "platform";
  userVerification?: "discouraged" | "preferred" | "required";
}

export async function generatePasskeyRegistrationOptions(
  input: PasskeyRegistrationOptionsInput,
) {
  const excludeCredentials = input.excludeCredentialIds?.map((id) => ({
    id,
    transports: AUTHENTICATOR_TRANSPORTS,
  }));
  return generateRegistrationOptions({
    rpName: input.rpName,
    rpID: input.rp.rpID,
    userID: new TextEncoder().encode(input.userId),
    userName: input.userName,
    userDisplayName: input.userDisplayName,
    attestationType: "none",
    authenticatorSelection: {
      residentKey: "required",
      requireResidentKey: true,
      userVerification: input.userVerification ?? "required",
      ...(input.authenticatorAttachment
        ? { authenticatorAttachment: input.authenticatorAttachment }
        : undefined),
    },
    ...(excludeCredentials ? { excludeCredentials } : undefined),
  });
}

export interface PasskeyAuthenticationOptionsInput {
  rp: WebAuthnRpConfig;
  allowCredentialIds?: string[];
  userVerification?: "discouraged" | "preferred" | "required";
  hints?: Array<"client-device" | "hybrid" | "security-key">;
}

export async function generatePasskeyAuthenticationOptions(
  input: PasskeyAuthenticationOptionsInput,
) {
  const allowCredentials = input.allowCredentialIds?.map((id) => ({
    id,
    transports: AUTHENTICATOR_TRANSPORTS,
  }));
  return generateAuthenticationOptions({
    rpID: input.rp.rpID,
    userVerification: input.userVerification ?? "required",
    ...(input.hints && input.hints.length > 0
      ? { hints: input.hints }
      : undefined),
    ...(allowCredentials ? { allowCredentials } : undefined),
  });
}

export interface VerifyPasskeyRegistrationInput {
  rp: WebAuthnRpConfig;
  challenge: string;
  response: RegistrationResponseJSON;
  requireUserVerification?: boolean;
}

export async function verifyPasskeyRegistration(
  input: VerifyPasskeyRegistrationInput,
): Promise<VerifiedRegistration | null> {
  try {
    const result = await simpleWebAuthnSeams.verifyRegistrationResponse({
      response: input.response,
      expectedChallenge: input.challenge,
      expectedOrigin: input.rp.origin,
      expectedRPID: input.rp.rpID,
      requireUserVerification: input.requireUserVerification ?? true,
    });
    if (!result.verified || !result.registrationInfo) return null;
    const { credential } = result.registrationInfo;
    return {
      credentialId: credential.id,
      publicKey: credential.publicKey,
      counter: credential.counter,
    };
  } catch {
    return null;
  }
}

export interface VerifyPasskeyAuthenticationInput {
  rp: WebAuthnRpConfig;
  challenge: string;
  response: AuthenticationResponseJSON;
  credential: Pick<PasskeyCredential, "credentialId" | "publicKey" | "counter">;
  requireUserVerification?: boolean;
}

export async function verifyPasskeyAuthentication(
  input: VerifyPasskeyAuthenticationInput,
): Promise<number | null | undefined> {
  try {
    const result = await simpleWebAuthnSeams.verifyAuthenticationResponse({
      response: input.response,
      expectedChallenge: input.challenge,
      expectedOrigin: input.rp.origin,
      expectedRPID: input.rp.rpID,
      credential: {
        id: input.credential.credentialId,
        publicKey: input.credential.publicKey,
        counter: input.credential.counter,
      },
      requireUserVerification: input.requireUserVerification ?? true,
    });
    return result.verified ? result.authenticationInfo?.newCounter : null;
  } catch {
    return null;
  }
}

/**
 * Why a challenge was issued.
 *
 * `transaction` is not "authentication with a label": it names a ceremony
 * that was minted against one specific approval transaction and may only be
 * spent on that transaction. What makes that true is `transactionDigest`
 * below plus the durable activation row the control plane keeps — this store
 * is process-local and is a courtesy, not the fence.
 */
export type ChallengePurpose =
  | "authentication"
  | "registration"
  | "transaction";

export interface ChallengeMeta {
  /** Bound principal when issued under an authenticated session; null if unbound. */
  principalId: string | null;
  expiresAt: number;
  purpose: ChallengePurpose;
  /**
   * The approval transaction this challenge was minted for (`transaction`
   * purpose only). The verifier compares it against the transaction the
   * caller claims to be settling, so an assertion obtained for one request,
   * one decision or one policy cannot be presented against another.
   */
  transactionDigest?: string;
}

export interface PasskeyChallengeStore {
  set(challenge: string, meta: ChallengeMeta): void;
  consume(challenge: string): ChallengeMeta | undefined;
  /**
   * Read a challenge's metadata without spending it.
   *
   * The transaction-bound ceremony needs to check what a challenge was minted
   * *for* before handing the assertion to the verifier that consumes it.
   * Consuming it here instead would leave the verifier with nothing to check
   * the assertion against, and re-inserting it afterwards would open a window
   * where two callers hold the same one-time value.
   */
  peek(challenge: string): ChallengeMeta | undefined;
}

export interface AuthenticationChallengeResult {
  challenge: string;
  options: Awaited<ReturnType<typeof generateAuthenticationOptions>>;
}

export interface RegistrationChallengeResult {
  challenge: string;
  options: Awaited<ReturnType<typeof generateRegistrationOptions>>;
}

/**
 * Outstanding challenges kept in memory. Issuing is cheap and unbounded from the
 * caller's side, so the store prunes expired rows and refuses to grow past this.
 */
export const MAX_OUTSTANDING_CHALLENGES = 4096;

export function createMemoryChallengeStore(): PasskeyChallengeStore {
  const map = new Map<string, ChallengeMeta>();
  const byPrincipal = new Map<string | null, Set<string>>();
  let nextExpiry = Number.POSITIVE_INFINITY;

  const remove = (challenge: string): void => {
    const row = map.get(challenge);
    if (!row) return;
    map.delete(challenge);
    const own = byPrincipal.get(row.principalId);
    own?.delete(challenge);
    if (own?.size === 0) byPrincipal.delete(row.principalId);
  };

  return {
    set(challenge, meta) {
      const now = Date.now();
      if (now > nextExpiry) {
        nextExpiry = Number.POSITIVE_INFINITY;
        for (const [key, row] of map) {
          if (now > row.expiresAt) remove(key);
          else nextExpiry = Math.min(nextExpiry, row.expiresAt);
        }
      }
      remove(challenge);
      if (map.size >= MAX_OUTSTANDING_CHALLENGES) {
        // Evict the issuer's own oldest challenge first. Dropping whatever is
        // oldest globally would let one principal, by asking for challenges in
        // bulk, knock another principal's ceremony out of the store mid-login.
        const own = byPrincipal.get(meta.principalId)?.values().next().value;
        const victim = own ?? map.keys().next().value;
        if (victim !== undefined) remove(victim);
      }
      map.set(challenge, meta);
      const own = byPrincipal.get(meta.principalId) ?? new Set<string>();
      own.add(challenge);
      byPrincipal.set(meta.principalId, own);
      nextExpiry = Math.min(nextExpiry, meta.expiresAt);
    },
    consume(challenge) {
      const row = map.get(challenge);
      remove(challenge);
      if (!row) return undefined;
      if (Date.now() > row.expiresAt) return undefined;
      return row;
    },
    peek(challenge) {
      const row = map.get(challenge);
      if (!row) return undefined;
      // Expiry is applied on read rather than only on eviction: a lapsed
      // challenge must look absent to a reader too, or a peek would answer
      // "valid" for something `consume` would refuse a line later.
      if (Date.now() > row.expiresAt) return undefined;
      return row;
    },
  };
}

export async function issueAuthenticationChallenge(
  store: PasskeyChallengeStore,
  rp: WebAuthnRpConfig,
  opts?: { principalId?: string; allowCredentials?: { id: string }[] },
): Promise<AuthenticationChallengeResult> {
  const genArgs: GenerateAuthenticationOptionsOpts = {
    rpID: rp.rpID,
    // Required, not preferred: a passkey is this system's production MFA factor,
    // and an assertion that skipped user verification proves possession of the
    // authenticator only — one factor wearing two factors' name.
    userVerification: "required",
  };
  if (opts?.allowCredentials && opts.allowCredentials.length > 0) {
    const transports: AuthenticatorTransportFuture[] = [
      "internal",
      "hybrid",
      "usb",
      "ble",
      "nfc",
    ];
    genArgs.allowCredentials = opts.allowCredentials.map((c) => ({
      id: c.id,
      transports,
    }));
  }
  const options = await generateAuthenticationOptions(genArgs);
  store.set(options.challenge, {
    principalId: opts?.principalId ?? null,
    expiresAt: Date.now() + 5 * 60_000,
    purpose: "authentication",
  });
  return { challenge: options.challenge, options };
}

/**
 * Issue a challenge that may only be spent on one approval transaction.
 *
 * The digest is carried on the challenge rather than recomputed later,
 * because "which transaction is this ceremony for?" has to be decided when
 * the ceremony *starts*. A challenge that learned its meaning at verification
 * time would be a challenge an attacker could re-aim: the person would touch
 * their authenticator for the request they were reading, and the server would
 * supply whichever transaction it was asked about afterwards.
 *
 * `userVerification: "required"` is inherited from the options generator: an
 * approval that only proved possession of a device is one factor wearing two
 * factors' name.
 */
export async function issueTransactionChallenge(
  store: PasskeyChallengeStore,
  rp: WebAuthnRpConfig,
  opts: {
    principalId: string;
    transactionDigest: string;
    allowCredentials?: { id: string }[];
    ttlMs?: number;
  },
): Promise<AuthenticationChallengeResult> {
  const genArgs: GenerateAuthenticationOptionsOpts = {
    rpID: rp.rpID,
    userVerification: "required",
  };
  if (opts.allowCredentials && opts.allowCredentials.length > 0) {
    genArgs.allowCredentials = opts.allowCredentials.map((c) => ({
      id: c.id,
      transports: AUTHENTICATOR_TRANSPORTS,
    }));
  }
  const options = await generateAuthenticationOptions(genArgs);
  store.set(options.challenge, {
    principalId: opts.principalId,
    expiresAt: Date.now() + (opts.ttlMs ?? 5 * 60_000),
    purpose: "transaction",
    transactionDigest: opts.transactionDigest,
  });
  return { challenge: options.challenge, options };
}

/** Issue a one-time registration challenge (production passkey enroll). */
export async function issueRegistrationChallenge(
  store: PasskeyChallengeStore,
  rp: WebAuthnRpConfig,
  opts: { principalId: string; userName?: string; userDisplayName?: string },
): Promise<RegistrationChallengeResult> {
  const userName = opts.userName ?? opts.principalId;
  const options = await generateRegistrationOptions({
    rpName: "OpenSesame",
    rpID: rp.rpID,
    userName,
    userDisplayName: opts.userDisplayName ?? userName,
    // Stable per-principal user handle (not a secret).
    userID: new TextEncoder().encode(opts.principalId),
    // Prefer attestation when the authenticator provides it; still verify the
    // ceremony (challenge/origin/RPID) when attestation is "none".
    attestationType: "direct",
    authenticatorSelection: {
      residentKey: "preferred",
      // Enrol only authenticators that can verify their user; otherwise the
      // credential can never satisfy the assertion requirement below.
      userVerification: "required",
    },
  });
  store.set(options.challenge, {
    principalId: opts.principalId,
    expiresAt: Date.now() + 5 * 60_000,
    purpose: "registration",
  });
  return { challenge: options.challenge, options };
}

export type VerifiedRegistration = {
  credentialId: string;
  publicKey: Uint8Array;
  counter: number;
};

/**
 * Verify a registration response against a stored challenge.
 * Returns credential material on success; null on any failure.
 */
export async function verifyRegistrationAttestation(
  store: PasskeyChallengeStore,
  rp: WebAuthnRpConfig,
  response: RegistrationResponseJSON,
  expectedPrincipalId: string,
): Promise<VerifiedRegistration | null> {
  let clientData: { challenge?: string };
  try {
    const raw = Buffer.from(
      response.response.clientDataJSON.replace(/-/g, "+").replace(/_/g, "/"),
      "base64",
    ).toString("utf8");
    clientData = overlapCast(JSON.parse(raw));
  } catch {
    return null;
  }
  const challenge = clientData.challenge;
  if (!challenge || !isString(challenge)) return null;
  const issued = store.consume(challenge);
  if (!issued || issued.purpose !== "registration") return null;
  if (issued.principalId !== expectedPrincipalId) return null;

  try {
    return verifyPasskeyRegistration({ rp, challenge, response });
  } catch {
    return null;
  }
}

export function createSimpleWebAuthnVerifyFn(
  rp: WebAuthnRpConfig,
  store: PasskeyChallengeStore,
): PasskeyVerifyFn {
  return async (assertion: PasskeyAssertion, credential: PasskeyCredential) => {
    let clientData: { challenge?: string; type?: string; origin?: string };
    try {
      clientData = overlapCast(
        JSON.parse(Buffer.from(assertion.clientDataJSON).toString("utf8")),
      );
    } catch {
      return false;
    }
    const challenge = clientData.challenge;
    if (!challenge || !isString(challenge)) return false;
    const issued = store.consume(challenge);
    // The purpose the caller expected, and nothing else.
    //
    // Both purposes prove the same momentary fact — this person, this
    // authenticator, just now — so the signature cannot tell them apart and
    // only the challenge's purpose can. Accepting either way round would let
    // a page mint an approval ceremony, have somebody touch their key for
    // something that looked harmless, and redeem the assertion as a login;
    // the mirror substitution, spending a plain sign-in challenge on an
    // approval, is refused here *and* by the activation row, which stores the
    // digest of the one challenge it was minted with.
    //
    // Defaulting to `authentication` keeps the narrow answer the safe one for
    // any caller who did not think about it.
    const expectedPurpose = assertion.expectedPurpose ?? "authentication";
    if (!issued || issued.purpose !== expectedPurpose) {
      return false;
    }
    if (issued.principalId && issued.principalId !== credential.principalId) {
      return false;
    }

    const response: AuthenticationResponseJSON = {
      id: assertion.credentialId,
      rawId: assertion.credentialId,
      type: "public-key",
      response: {
        clientDataJSON: toBase64Url(assertion.clientDataJSON),
        authenticatorData: toBase64Url(assertion.authenticatorData),
        signature: toBase64Url(assertion.signature),
      },
      clientExtensionResults: {},
    };

    try {
      const newCounter = await verifyPasskeyAuthentication({
        rp,
        challenge,
        response,
        credential,
      });
      if (newCounter === null) return false;
      return newCounter === undefined ? { ok: true } : { ok: true, newCounter };
    } catch {
      return false;
    }
  };
}
