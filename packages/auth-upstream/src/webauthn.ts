/**
 * Production WebAuthn registration + assertion via @simplewebauthn/server.
 * Requires a previously issued challenge that matches clientDataJSON.challenge.
 */
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticatorTransportFuture,
  type GenerateAuthenticationOptionsOpts,
} from "@simplewebauthn/server";
import type {
  AuthenticationResponseJSON,
  RegistrationResponseJSON,
} from "@simplewebauthn/server";
import type { PasskeyAssertion, PasskeyCredential, PasskeyVerifyFn } from "./passkey.js";

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

export function createMemoryChallengeStore(): PasskeyChallengeStore {
  const map = new Map<string, ChallengeMeta>();
  return {
    set(challenge, meta) {
      map.set(challenge, meta);
    },
    consume(challenge) {
      const row = map.get(challenge);
      map.delete(challenge);
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
): Promise<{
  challenge: string;
  options: Awaited<ReturnType<typeof generateAuthenticationOptions>>;
}> {
  const genArgs: GenerateAuthenticationOptionsOpts = {
    rpID: rp.rpID,
    userVerification: "preferred",
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
): Promise<{
  challenge: string;
  options: Awaited<ReturnType<typeof generateRegistrationOptions>>;
}> {
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
      userVerification: "preferred",
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
    clientData = JSON.parse(raw) as typeof clientData;
  } catch {
    return null;
  }
  const challenge = clientData.challenge;
  if (!challenge || typeof challenge !== "string") return null;
  const issued = store.consume(challenge);
  if (!issued || issued.purpose !== "registration") return null;
  if (issued.principalId !== expectedPrincipalId) return null;

  try {
    const result = await verifyRegistrationResponse({
      response,
      expectedChallenge: challenge,
      expectedOrigin: rp.origin,
      expectedRPID: rp.rpID,
      requireUserVerification: false,
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

export function createSimpleWebAuthnVerifyFn(
  rp: WebAuthnRpConfig,
  store: PasskeyChallengeStore,
): PasskeyVerifyFn {
  return async (assertion: PasskeyAssertion, credential: PasskeyCredential) => {
    let clientData: { challenge?: string; type?: string; origin?: string };
    try {
      clientData = JSON.parse(
        Buffer.from(assertion.clientDataJSON).toString("utf8"),
      ) as typeof clientData;
    } catch {
      return false;
    }
    const challenge = clientData.challenge;
    if (!challenge || typeof challenge !== "string") return false;
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
      const result = await verifyAuthenticationResponse({
        response,
        expectedChallenge: challenge,
        expectedOrigin: rp.origin,
        expectedRPID: rp.rpID,
        credential: {
          id: credential.credentialId,
          publicKey: credential.publicKey,
          counter: credential.counter,
        },
        requireUserVerification: false,
      });
      return result.verified;
    } catch {
      return false;
    }
  };
}
