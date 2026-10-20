import { overlapCast } from "@opensesame/os-domain";
import { b64urlToBytes, isPublicKeyCredential } from "@opensesame/sdk-browser";
import { requireCredentials } from "../ports.js";
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

export async function getSignInCredential(
  start: LocalPasskeyCeremony,
  keys: LocalPasskey[],
  prf: Awaited<ReturnType<typeof prepareSignInPrf>>["extension"],
) {
  const credential = await requireCredentials().get({
    publicKey: {
      challenge: start.challenge,
      rpId: start.rp.rpID,
      userVerification: "required",
      timeout: PASSKEY_CEREMONY_MS,
      allowCredentials: keys.map((key) => ({
        type: "public-key",
        id: b64urlToBytes(key.credentialId),
      })),
      extensions: overlapCast({ prf }),
    },
  });
  if (!credential || !isPublicKeyCredential(credential))
    throw new LocalDirectoryError("Passkey verification was cancelled.");
  return { credential, verifier: await localPasskeyVerifierSeams.load() };
}
