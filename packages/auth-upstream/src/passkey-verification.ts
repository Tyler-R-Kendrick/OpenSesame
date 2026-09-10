import type {
  AuthenticationResponseJSON,
  RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { simpleWebAuthnSeams } from "./simplewebauthn.js";

export interface WebAuthnRpConfig {
  rpID: string;
  origin: string;
}

export type VerifiedRegistration = {
  credentialId: string;
  publicKey: Uint8Array;
  counter: number;
};

export interface VerifyPasskeyRegistrationInput {
  rp: WebAuthnRpConfig;
  challenge: string;
  response: RegistrationResponseJSON;
  requireUserVerification?: boolean;
}

/** Challenge admission and single-use consumption belong to the authority store. */
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
  credential: VerifiedRegistration;
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
