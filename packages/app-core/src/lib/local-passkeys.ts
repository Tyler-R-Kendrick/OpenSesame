import {
  verifyPasskeyAuthentication,
  verifyPasskeyRegistration,
} from "@opensesame/auth-upstream/browser";
import { isString, overlapCast } from "@opensesame/os-domain";
import {
  authenticationResponseJson,
  b64urlToBytes,
  bytesToB64url,
  isPublicKeyCredential,
  registrationResponseJson,
  sha256Base64Url,
} from "@opensesame/sdk-browser";
import {
  credentials,
  maybePage,
  page,
  pageOrigin,
  requireCredentials,
} from "../ports.js";
import {
  type LocalPasskey,
  readLocalPasskeys,
  requireLocalPerson,
  writeLocalPasskeys,
} from "./local-credentials.js";
import {
  LocalDirectoryError,
  readLocalDirectory,
  withLocalDirectoryLock,
} from "./local-directory.js";
import {
  applySignInPrf,
  prepareSignInPrf,
  zeroSignInPrfSalts,
} from "./local-passkey-prf.js";
import { onVaultLock } from "./vault/lock-events.js";
import {
  hasUsablePrfOutput,
  readPrfFirst,
} from "./vault/protection/adapters/webauthn-prf-output.js";
import { tombUnlocked } from "./vfs.js";

const CEREMONY_MS = 120_000;

export function viewBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  );
}

export type LocalAuthentication = Readonly<{
  tomb: string;
  principalId: string;
  credentialId: string;
  credentialCreatedAt: number;
  publicKeyB64: string;
  directoryRevision: number;
  authTime: number;
  origin: string;
  amr: readonly string[];
  /** Digest of the frozen request and decision, never inferred from identity. */
  requestDigest?: string;
}>;
let unspentAuthentications = new WeakMap<LocalAuthentication, number>();

/** Forget every unspent authentication; run on lock and on module dispose. */
export function resetLocalAuthentications(): void {
  unspentAuthentications = new WeakMap();
}

/**
 * Bind the lock reset. Called from `identity.local-iam`'s `activate` rather
 * than at module load (ownership.md §4.3: no top-level side effects); the
 * returned unbind also resets once, so disposal never leaves evidence live.
 */
export function bindLocalAuthenticationLockReset(): () => void {
  const off = onVaultLock(resetLocalAuthentications);
  return () => {
    off();
    resetLocalAuthentications();
  };
}

/** Only genuine, single-use evidence from this verifier can start a session. */
export function consumeLocalAuthentication(
  evidence: LocalAuthentication,
  requestDigest?: string,
) {
  const deadline = unspentAuthentications.get(evidence);
  if (
    !unspentAuthentications.delete(evidence) ||
    deadline === undefined ||
    performance.now() >= deadline ||
    !tombUnlocked(evidence.tomb) ||
    evidence.requestDigest !== requestDigest ||
    evidence.origin !== pageOrigin() ||
    Date.now() < evidence.authTime ||
    Date.now() - evidence.authTime >= CEREMONY_MS
  )
    throw new LocalDirectoryError("The identity proof is no longer valid.");
  return evidence;
}
function ceremony() {
  if (!maybePage()?.isSecureContext || !credentials())
    throw new LocalDirectoryError("Passkeys require a secure browser context.");
  return {
    challenge: crypto.getRandomValues(new Uint8Array(32)),
    rp: { origin: pageOrigin(), rpID: page().location.hostname },
    expiresAt: Date.now() + CEREMONY_MS,
  };
}

function requireLive(start: ReturnType<typeof ceremony>) {
  if (Date.now() >= start.expiresAt || pageOrigin() !== start.rp.origin)
    throw new LocalDirectoryError("The passkey ceremony expired. Start again.");
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

async function persistEnrolledPasskey(input: {
  tomb: string;
  principalId: string;
  start: ReturnType<typeof ceremony>;
  credential: PublicKeyCredential;
  verified: NonNullable<Awaited<ReturnType<typeof verifyPasskeyRegistration>>>;
  prfSalt: Uint8Array;
  userId: Uint8Array;
}): Promise<LocalPasskeyEnrollResult> {
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
    {
      principalId,
      credentialId: verified.credentialId,
      publicKeyB64: bytesToB64url(verified.publicKey),
      counter: verified.counter,
      createdAt: Date.now(),
      ...(prfSupported ? { prfCapable: true } : {}),
    },
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
  return withLocalDirectoryLock(tomb, () =>
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
}

async function getSignInCredential(
  start: ReturnType<typeof ceremony>,
  keys: LocalPasskey[],
  prf: { eval: { first: Uint8Array } },
): Promise<PublicKeyCredential> {
  const credential = await requireCredentials().get({
    publicKey: {
      challenge: start.challenge,
      rpId: start.rp.rpID,
      userVerification: "required",
      timeout: CEREMONY_MS,
      allowCredentials: keys.map((key) => ({
        type: "public-key",
        id: b64urlToBytes(key.credentialId),
      })),
      extensions: overlapCast({ prf }),
    },
  });
  if (!credential || !isPublicKeyCredential(credential))
    throw new LocalDirectoryError("Passkey verification was cancelled.");
  return credential;
}

/** Verifies possession and evaluates WebAuthn PRF. A usable result wraps this vault when it is open. */
export async function authenticateLocalPasskey(
  tomb: string,
  principalId: string,
  requestDigest?: string,
) {
  const authentications = unspentAuthentications;
  if (
    requestDigest !== undefined &&
    (!isString(requestDigest) || !/^[A-Za-z0-9_-]{43}$/.test(requestDigest))
  )
    throw new LocalDirectoryError("The request digest is invalid.");
  const start = ceremony();
  if (requestDigest !== undefined)
    start.challenge = b64urlToBytes(
      await sha256Base64Url(
        JSON.stringify([
          "opensesame:local-approval:v1",
          bytesToB64url(start.challenge),
          requestDigest,
        ]),
      ),
    );
  const keys = await withLocalDirectoryLock(tomb, async () => {
    await requireLocalPerson(tomb, principalId);
    return (await readLocalPasskeys(tomb)).filter(
      (key) => key.principalId === principalId,
    );
  });
  if (keys.length === 0)
    throw new LocalDirectoryError("Enroll a passkey for this identity first.");
  const prf = await prepareSignInPrf(tomb, keys);
  let credential: PublicKeyCredential;
  try {
    credential = await getSignInCredential(start, keys, prf.extension);
  } catch (error) {
    zeroSignInPrfSalts(prf.plan);
    throw error;
  }
  return withLocalDirectoryLock(tomb, async () => {
    requireLive(start);
    await requireLocalPerson(tomb, principalId);
    const current = await readLocalPasskeys(tomb);
    const key = current.find(
      (row) =>
        row.principalId === principalId && row.credentialId === credential.id,
    );
    if (!key)
      throw new LocalDirectoryError("This credential has been revoked.");
    const counter = await verifyPasskeyAuthentication({
      rp: start.rp,
      challenge: bytesToB64url(start.challenge),
      response: authenticationResponseJson(credential),
      requireUserVerification: true,
      credential: {
        credentialId: key.credentialId,
        publicKey: b64urlToBytes(key.publicKeyB64),
        counter: key.counter,
      },
    });
    if (counter === null || counter === undefined)
      throw new LocalDirectoryError("The identity proof was refused.");
    requireLive(start);
    const prfSupported = await applySignInPrf(
      tomb,
      principalId,
      credential,
      prf.plan,
    );
    await writeLocalPasskeys(
      tomb,
      current.map((row) =>
        row.credentialId === key.credentialId
          ? {
              ...row,
              counter,
              ...(prfSupported ? { prfCapable: true } : {}),
            }
          : row,
      ),
    );
    const evidence: LocalAuthentication = Object.freeze({
      tomb,
      principalId,
      credentialId: key.credentialId,
      credentialCreatedAt: key.createdAt,
      publicKeyB64: key.publicKeyB64,
      directoryRevision: (await readLocalDirectory(tomb)).revision,
      authTime: Date.now(),
      origin: start.rp.origin,
      amr: Object.freeze(["webauthn", "user_verification"]),
      requestDigest,
    });
    requireLive(start);
    if (authentications !== unspentAuthentications)
      throw new LocalDirectoryError("The identity proof is no longer valid.");
    authentications.set(evidence, performance.now() + CEREMONY_MS);
    return evidence;
  });
}
