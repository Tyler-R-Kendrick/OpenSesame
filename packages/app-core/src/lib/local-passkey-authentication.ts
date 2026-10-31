/** Genuine local WebAuthn authentication with explicit pre-unlock IAM custody. */
import { isString } from "@opensesame/os-domain";
import {
  authenticationResponseJson,
  b64urlToBytes,
  bytesToB64url,
  sha256Base64Url,
} from "@opensesame/sdk-browser";
import { pageOrigin } from "../ports.js";
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
import {
  type LocalIamAccess,
  advanceLocalPasskeyCounter,
  checkLocalIamAccess,
} from "./local-iam-access.js";
import { notifyLocalIamChange } from "./local-iam-events.js";
import {
  type LocalPasskeyCeremony,
  PASSKEY_CEREMONY_MS,
  getSignInCredential,
  requireLiveLocalPasskey,
  startLocalPasskeyCeremony,
} from "./local-passkey-ceremony.js";
import {
  applySignInPrf,
  prepareSignInPrf,
  zeroSignInPrfSalts,
} from "./local-passkey-prf.js";
import { onVaultLock } from "./vault/lock-events.js";
import { tombUnlocked } from "./vfs.js";

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
  requestDigest?: string | undefined;
}>;
let unspentAuthentications = new WeakMap<LocalAuthentication, number>();

export function resetLocalAuthentications(): void {
  unspentAuthentications = new WeakMap();
}

export function bindLocalAuthenticationLockReset(): () => void {
  const off = onVaultLock(resetLocalAuthentications);
  return () => {
    off();
    resetLocalAuthentications();
  };
}

/** Only genuine, single-use evidence from ordinary sign-in can start a session. */
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
    Date.now() - evidence.authTime >= PASSKEY_CEREMONY_MS
  )
    throw new LocalDirectoryError("The identity proof is no longer valid.");
  return evidence;
}

function live(
  tomb: string,
  start: LocalPasskeyCeremony,
  access?: LocalIamAccess,
) {
  if (access) checkLocalIamAccess(access, tomb);
  requireLiveLocalPasskey(start);
}

async function eligibleKeys(
  tomb: string,
  principalId: string,
  access?: LocalIamAccess,
) {
  return withLocalDirectoryLock(tomb, async () => {
    if (access) checkLocalIamAccess(access, tomb);
    await requireLocalPerson(tomb, principalId, access);
    const keys = await readLocalPasskeys(tomb, access);
    if (access) checkLocalIamAccess(access, tomb);
    return keys.filter((key) => key.principalId === principalId);
  });
}

type AuthenticationInput = {
  tomb: string;
  principalId: string;
  start: LocalPasskeyCeremony;
  assertion: Awaited<ReturnType<typeof getSignInCredential>>;
  prf: Awaited<ReturnType<typeof prepareSignInPrf>> | null;
  authentications: WeakMap<LocalAuthentication, number>;
  requestDigest: string | undefined;
  access: LocalIamAccess | undefined;
};

async function finishAuthentication(
  input: AuthenticationInput,
): Promise<LocalAuthentication> {
  const {
    tomb,
    principalId,
    start,
    assertion: { credential, verifier },
    prf,
    access,
  } = input;
  live(tomb, start, access);
  await requireLocalPerson(tomb, principalId, access);
  const current = await readLocalPasskeys(tomb, access);
  live(tomb, start, access);
  const key = current.find(
    (row) =>
      row.principalId === principalId && row.credentialId === credential.id,
  );
  if (!key) throw new LocalDirectoryError("This credential has been revoked.");
  const counter = await verifier.verifyPasskeyAuthentication({
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
  live(tomb, start, access);
  if (counter === null || counter === undefined)
    throw new LocalDirectoryError("The identity proof was refused.");
  if (access) {
    try {
      await advanceLocalPasskeyCounter(
        access,
        tomb,
        key.credentialId,
        key.counter,
        counter,
      );
    } finally {
      notifyLocalIamChange();
    }
  } else {
    const supported = prf
      ? await applySignInPrf(tomb, principalId, credential, prf.plan)
      : false;
    live(tomb, start);
    await writeLocalPasskeys(
      tomb,
      current.map((row) => {
        if (row.credentialId !== key.credentialId) return row;
        const updated = { ...row, counter };
        if (supported) updated.prfCapable = true;
        return updated;
      }),
    );
  }
  live(tomb, start, access);
  const directory = await readLocalDirectory(tomb, access);
  live(tomb, start, access);
  const evidence: LocalAuthentication = Object.freeze({
    tomb,
    principalId,
    credentialId: key.credentialId,
    credentialCreatedAt: key.createdAt,
    publicKeyB64: key.publicKeyB64,
    directoryRevision: directory.revision,
    authTime: Date.now(),
    origin: start.rp.origin,
    amr: Object.freeze(["webauthn", "user_verification"]),
    requestDigest: input.requestDigest,
  });
  if (input.authentications !== unspentAuthentications)
    throw new LocalDirectoryError("The identity proof is no longer valid.");
  // Approval proves the contact to the original unlock; it grants no IAM session.
  if (!access)
    input.authentications.set(
      evidence,
      performance.now() + PASSKEY_CEREMONY_MS,
    );
  return evidence;
}

/** The optional private handle reads only IAM and persists only an assertion counter. */
export async function authenticateLocalPasskey(
  tomb: string,
  principalId: string,
  requestDigest?: string,
  access?: LocalIamAccess,
): Promise<LocalAuthentication> {
  const authentications = unspentAuthentications;
  if (access) checkLocalIamAccess(access, tomb);
  if (
    requestDigest !== undefined &&
    (!isString(requestDigest) || !/^[A-Za-z0-9_-]{43}$/.test(requestDigest))
  )
    throw new LocalDirectoryError("The request digest is invalid.");
  const start = startLocalPasskeyCeremony();
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
  live(tomb, start, access);
  const keys = await eligibleKeys(tomb, principalId, access);
  live(tomb, start, access);
  if (keys.length === 0)
    throw new LocalDirectoryError("Enroll a passkey for this identity first.");
  // Root wrapping belongs to ordinary, already-unlocked sign-in.
  const prf = access ? null : await prepareSignInPrf(tomb, keys);
  try {
    live(tomb, start, access);
    const assertion = await getSignInCredential(start, keys, prf?.extension);
    live(tomb, start, access);
    return await withLocalDirectoryLock(tomb, () =>
      finishAuthentication({
        tomb,
        principalId,
        start,
        assertion,
        prf,
        authentications,
        requestDigest,
        access,
      }),
    );
  } finally {
    if (prf) zeroSignInPrfSalts(prf.plan);
  }
}
