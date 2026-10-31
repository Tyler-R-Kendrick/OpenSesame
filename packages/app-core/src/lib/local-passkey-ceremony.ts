import { overlapCast, asBufferSource } from "@opensesame/os-domain";
import { b64urlToBytes, isPublicKeyCredential } from "@opensesame/sdk-browser";
import {
  credentials,
  maybePage,
  page,
  pageOrigin,
  requireCredentials,
} from "../ports.js";
import type { LocalPasskey } from "./local-credentials.js";
import { LocalDirectoryError } from "./local-directory.js";
import type { prepareSignInPrf } from "./local-passkey-prf.js";

export const PASSKEY_CEREMONY_MS = 120_000;

export type LocalPasskeyCeremony = {
  challenge: Uint8Array;
  rp: { origin: string; rpID: string };
  expiresAt: number;
};

export const localPasskeyVerifierSeams = {
  load: () => import("@opensesame/auth-upstream/browser"),
};

export function startLocalPasskeyCeremony(): LocalPasskeyCeremony {
  if (!maybePage()?.isSecureContext || !credentials())
    throw new LocalDirectoryError("Passkeys require a secure browser context.");
  return {
    challenge: crypto.getRandomValues(new Uint8Array(32)),
    rp: { origin: pageOrigin(), rpID: page().location.hostname },
    expiresAt: Date.now() + PASSKEY_CEREMONY_MS,
  };
}

export function requireLiveLocalPasskey(start: LocalPasskeyCeremony): void {
  if (Date.now() >= start.expiresAt || pageOrigin() !== start.rp.origin)
    throw new LocalDirectoryError("The passkey ceremony expired. Start again.");
}

export async function getSignInCredential(
  start: LocalPasskeyCeremony,
  keys: LocalPasskey[],
  prf?: Awaited<ReturnType<typeof prepareSignInPrf>>["extension"],
) {
  const publicKey: PublicKeyCredentialRequestOptions = {
    challenge: asBufferSource(start.challenge),
    rpId: start.rp.rpID,
    userVerification: "required",
    timeout: PASSKEY_CEREMONY_MS,
    allowCredentials: keys.map((key) => ({
      type: "public-key",
      id: asBufferSource(b64urlToBytes(key.credentialId)),
    })),
  };
  if (prf) publicKey.extensions = overlapCast({ prf });
  const credential = await requireCredentials().get({ publicKey });
  if (!credential || !isPublicKeyCredential(credential))
    throw new LocalDirectoryError("Passkey verification was cancelled.");
  return { credential, verifier: await localPasskeyVerifierSeams.load() };
}
