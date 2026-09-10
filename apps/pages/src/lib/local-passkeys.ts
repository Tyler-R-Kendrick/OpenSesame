import {
  verifyPasskeyAuthentication,
  verifyPasskeyRegistration,
} from "@opensesame/auth-upstream/browser";
import { isString } from "@opensesame/os-domain";
import {
  authenticationResponseJson,
  b64urlToBytes,
  bytesToB64url,
  isPublicKeyCredential,
  registrationResponseJson,
  sha256Base64Url,
} from "@opensesame/sdk-browser";
import {
  readLocalPasskeys,
  requireLocalPerson,
  writeLocalPasskeys,
} from "./local-credentials.js";
import {
  LocalDirectoryError,
  readLocalDirectory,
  withLocalDirectoryLock,
} from "./local-directory.js";
import { vaultStore } from "./vault/store.js";
import { tombUnlocked } from "./vfs.js";

const CEREMONY_MS = 120_000;
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
vaultStore.onLock(() => {
  unspentAuthentications = new WeakMap();
});

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
    evidence.origin !== location.origin ||
    Date.now() < evidence.authTime ||
    Date.now() - evidence.authTime >= CEREMONY_MS
  )
    throw new LocalDirectoryError("The identity proof is no longer valid.");
  return evidence;
}
function ceremony() {
  if (!globalThis.isSecureContext || !navigator.credentials)
    throw new LocalDirectoryError("Passkeys require a secure browser context.");
  return {
    challenge: crypto.getRandomValues(new Uint8Array(32)),
    rp: { origin: location.origin, rpID: location.hostname },
    expiresAt: Date.now() + CEREMONY_MS,
  };
}

function requireLive(start: ReturnType<typeof ceremony>) {
  if (Date.now() >= start.expiresAt || location.origin !== start.rp.origin)
    throw new LocalDirectoryError("The passkey ceremony expired. Start again.");
}

/** Human vault-custodian action. Never exposed as an agent enrollment tool. */
export async function enrollLocalPasskey(
  tomb: string,
  principalId: string,
): Promise<void> {
  const start = ceremony();
  const { person, keys } = await withLocalDirectoryLock(tomb, async () => ({
    person: await requireLocalPerson(tomb, principalId),
    keys: await readLocalPasskeys(tomb),
  }));
  const credential = await navigator.credentials.create({
    publicKey: {
      challenge: start.challenge,
      rp: { id: start.rp.rpID, name: "OpenSesame local identity" },
      user: {
        id: new TextEncoder().encode(principalId),
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
  await withLocalDirectoryLock(tomb, async () => {
    requireLive(start);
    await requireLocalPerson(tomb, principalId);
    const current = await readLocalPasskeys(tomb);
    if (current.some((key) => key.credentialId === verified.credentialId))
      throw new LocalDirectoryError("This credential is already registered.");
    await writeLocalPasskeys(tomb, [
      ...current,
      {
        principalId,
        credentialId: verified.credentialId,
        publicKeyB64: bytesToB64url(verified.publicKey),
        counter: verified.counter,
        createdAt: Date.now(),
      },
    ]);
  });
}

/** Verifies possession; the returned evidence alone is not a transferable session. */
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
  const credential = await navigator.credentials.get({
    publicKey: {
      challenge: start.challenge,
      rpId: start.rp.rpID,
      userVerification: "required",
      timeout: CEREMONY_MS,
      allowCredentials: keys.map((key) => ({
        type: "public-key",
        id: b64urlToBytes(key.credentialId),
      })),
    },
  });
  if (!credential || !isPublicKeyCredential(credential))
    throw new LocalDirectoryError("Passkey verification was cancelled.");
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
    await writeLocalPasskeys(
      tomb,
      current.map((row) =>
        row.credentialId === key.credentialId ? { ...row, counter } : row,
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
