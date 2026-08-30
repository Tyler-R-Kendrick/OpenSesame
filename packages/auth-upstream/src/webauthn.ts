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

export type ChallengePurpose = "authentication" | "registration";

export interface ChallengeMeta {
  /** Bound principal when issued under an authenticated session; null if unbound. */
  principalId: string | null;
  expiresAt: number;
  purpose: ChallengePurpose;
}

export interface PasskeyChallengeStore {
  set(challenge: string, meta: ChallengeMeta): void;
  consume(challenge: string): ChallengeMeta | undefined;
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
    if (!issued || issued.purpose !== "authentication") return false;
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
