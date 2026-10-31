import type { VerifiedRegistration } from "@opensesame/auth-upstream/browser";
import { overlapCast } from "@opensesame/os-domain";
import {
  b64urlToBytes,
  bytesToB64url,
  isPublicKeyCredential,
  registrationResponseJson,
} from "@opensesame/sdk-browser";
import { requireCredentials } from "../ports.js";
import {
  type LocalPasskey,
  readLocalPasskeys,
  requireLocalPerson,
  writeLocalPasskeys,
} from "./local-credentials.js";
import {
  LocalDirectoryError,
  withLocalDirectoryLock,
} from "./local-directory.js";
import {
  PASSKEY_CEREMONY_MS,
  startLocalPasskeyCeremony as ceremony,
  localPasskeyVerifierSeams,
  requireLiveLocalPasskey as requireLive,
} from "./local-passkey-ceremony.js";
import {
  hasUsablePrfOutput,
  readPrfFirst,
} from "./vault/protection/adapters/webauthn-prf-output.js";

const CEREMONY_MS = PASSKEY_CEREMONY_MS;

export function viewBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  );
}

export type LocalPasskeyVaultOffer = {
  prfOutput: Uint8Array;
  prfSalt: Uint8Array;
  credentialId: ArrayBuffer;
  userId: Uint8Array;
  discard(): void;
};

export type LocalPasskeyEnrollResult = {
  credentialId: string;
  /** Registration returned a 32-byte PRF result. Not yet a vault protector. */
  prfSupported: boolean;
  vaultOffer: LocalPasskeyVaultOffer | null;
};

function withPrfCapability(
  key: LocalPasskey,
  supported: boolean,
): LocalPasskey {
  if (supported) key.prfCapable = true;
  return key;
}

type EnrolledPasskeyInput = {
  tomb: string;
  principalId: string;
  start: ReturnType<typeof ceremony>;
  credential: PublicKeyCredential;
  verified: VerifiedRegistration;
  prfSalt: Uint8Array;
  userId: Uint8Array;
};

async function persistEnrolledPasskey(
  input: EnrolledPasskeyInput,
): Promise<LocalPasskeyEnrollResult> {
  const { tomb, principalId, start, credential, verified, prfSalt, userId } =
    input;
  requireLive(start);
  await requireLocalPerson(tomb, principalId);
  const current = await readLocalPasskeys(tomb);
  if (current.some((key) => key.credentialId === verified.credentialId))
    throw new LocalDirectoryError("This credential is already registered.");
  const extensionResults = credential.getClientExtensionResults();
  const prfFirst = readPrfFirst(extensionResults);
  const prfSupported =
    hasUsablePrfOutput(extensionResults) && prfFirst !== null;
  await writeLocalPasskeys(tomb, [
    ...current,
    withPrfCapability(
      {
        principalId,
        credentialId: verified.credentialId,
        publicKeyB64: bytesToB64url(verified.publicKey),
        counter: verified.counter,
        createdAt: Date.now(),
      },
      prfSupported,
    ),
  ]);
  if (!prfSupported) {
    prfSalt.fill(0);
    return {
      credentialId: verified.credentialId,
      prfSupported: false,
      vaultOffer: null,
    };
  }
  const prfOutput = new Uint8Array(prfFirst);
  return {
    credentialId: verified.credentialId,
    prfSupported: true,
    vaultOffer: {
      prfOutput,
      prfSalt,
      credentialId: credential.rawId,
      userId,
      discard() {
        prfOutput.fill(0);
        prfSalt.fill(0);
      },
    },
  };
}

/** Human vault-custodian action. Never exposed as an agent enrollment tool.
 *  Requests WebAuthn PRF. A usable result is offered back to the caller; this
 *  function never wraps a vault key.
 */
export async function enrollLocalPasskey(
  tomb: string,
  principalId: string,
): Promise<LocalPasskeyEnrollResult> {
  const start = ceremony();
  const { person, keys } = await withLocalDirectoryLock(tomb, async () => ({
    person: await requireLocalPerson(tomb, principalId),
    keys: await readLocalPasskeys(tomb),
  }));
  const prfSalt = crypto.getRandomValues(new Uint8Array(32));
  const userId = new TextEncoder().encode(principalId);
  try {
    const credential = await requireCredentials().create({
      publicKey: {
        challenge: start.challenge,
        rp: { id: start.rp.rpID, name: "OpenSesame local identity" },
        user: {
          id: userId,
          name: person.name,
          displayName: person.name,
        },
        pubKeyCredParams: [{ type: "public-key", alg: -7 }],
        authenticatorSelection: {
          residentKey: "required",
          userVerification: "required",
        },
        attestation: "none",
        timeout: CEREMONY_MS,
        excludeCredentials: keys
          .filter((key) => key.principalId === principalId)
          .map((key) => ({
            type: "public-key",
            id: b64urlToBytes(key.credentialId),
          })),
        extensions: overlapCast({
          prf: { eval: { first: prfSalt } },
        }),
      },
    });
    if (!credential || !isPublicKeyCredential(credential))
      throw new LocalDirectoryError("Passkey creation was cancelled.");
    const payload = registrationResponseJson(credential);
    const { verifyPasskeyRegistration } =
      await localPasskeyVerifierSeams.load();
    const verified = await verifyPasskeyRegistration({
      rp: start.rp,
      challenge: bytesToB64url(start.challenge),
      response: {
        ...payload,
        response: {
          clientDataJSON: payload.response.clientDataJSON,
          attestationObject: payload.response.attestationObject,
        },
      },
      requireUserVerification: true,
    });
    if (!verified)
      throw new LocalDirectoryError("The passkey could not be verified.");
    return await withLocalDirectoryLock(tomb, () =>
      persistEnrolledPasskey({
        tomb,
        principalId,
        start,
        credential,
        verified,
        prfSalt,
        userId,
      }),
    );
  } catch (error) {
    // Ownership passes to the returned vault offer; until then the salt must die.
    prfSalt.fill(0);
    throw error;
  }
}

export {
  type LocalAuthentication,
  authenticateLocalPasskey,
  bindLocalAuthenticationLockReset,
  consumeLocalAuthentication,
  resetLocalAuthentications,
} from "./local-passkey-authentication.js";
