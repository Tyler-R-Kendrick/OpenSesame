/**
 * WebAuthn PRF unlock ceremonies (create / get) with exact credential selection.
 * Failed ceremonies throw typed errors and never touch unlock wraps (KP-23).
 */

import { overlapCast } from "@opensesame/os-domain";
import { b64ToBytes, bytesToB64, randomBytes } from "@opensesame/vault-core";
import {
  isPublicKeyCredential,
  publicKeyCredentialApi,
  requireCredentials,
} from "../../../../ports.js";
import type {
  PasskeyCeremony,
  PasskeyUnlockCeremonyResult,
  PasskeyUnlockRecord,
} from "../../unlock-methods.js";
import {
  WebauthnHostError,
  assertWebauthnHost,
  describeWebauthnError,
  webauthnRpId,
} from "../../webauthn-host.js";
import {
  type CeremonyClientDataAssert,
  assertCeremonyClientData,
  credentialIdMatches,
  toWebauthnBase64Url,
} from "./webauthn-prf-client-data.js";
import {
  PrfCeremonyError,
  prfExtensionEnabled,
  readPrfFirst,
  requirePrfOutputFromExtension,
} from "./webauthn-prf-output.js";

export type PasskeyCeremonyGetOptions = {
  rpId?: string;
  signal?: AbortSignal | undefined;
  credentialIdB64?: string;
};

/**
 * Which kind of authenticator a new passkey may live on. Left unset, the
 * browser chooses and, on Windows, offers Windows Hello first — which may not
 * answer PRF at all — so a person who holds a security key names it here.
 */
export type PasskeyAttachment = "platform" | "cross-platform";

export type PasskeyCreateOptions = {
  attachment?: PasskeyAttachment | undefined;
};

function mapHostError<Thrown>(error: Thrown): never {
  if (error instanceof WebauthnHostError) {
    throw new PrfCeremonyError("invalid_host", error.message);
  }
  throw error;
}

/**
 * Most authenticators take the PRF extension at creation and compute nothing
 * until an assertion (`enabled: true`, no `results`) — a YubiKey whose
 * firmware lacks `hmac-secret-mc` is the common case. The salt is the one the
 * new credential will be asked for at unlock, so the output this returns is
 * the one that will open the vault later. A second touch, not a second key.
 */
async function evaluatePrfAfterCreate(
  credential: PublicKeyCredential,
  prfSalt: Uint8Array,
  rpId: string,
  signal: AbortSignal | undefined,
): Promise<ArrayBuffer> {
  const id: BufferSource = new Uint8Array(credential.rawId);
  const assertion = await getPasskeyCredential({
    publicKey: {
      challenge: overlapCast(randomBytes(32)),
      rpId,
      allowCredentials: [{ type: "public-key", id }],
      userVerification: "required",
      timeout: 120_000,
      extensions: overlapCast({ prf: { eval: { first: prfSalt } } }),
    },
    ...(signal ? { signal } : undefined),
  });
  assertCeremonyClientData(assertion, { rpId, expectCreate: false });
  if (
    bytesToB64(new Uint8Array(assertion.rawId)) !==
    bytesToB64(new Uint8Array(credential.rawId))
  ) {
    throw new PrfCeremonyError(
      "wrong_credential",
      "A different passkey answered than the one just created.",
    );
  }
  return requirePrfOutputFromExtension(assertion.getClientExtensionResults());
}

async function prfOutputForNewCredential(
  credential: PublicKeyCredential,
  prfSalt: Uint8Array,
  rpId: string,
  signal: AbortSignal | undefined,
): Promise<ArrayBuffer> {
  const results = credential.getClientExtensionResults();
  if (readPrfFirst(results)) return requirePrfOutputFromExtension(results);
  if (prfExtensionEnabled(results)) {
    return evaluatePrfAfterCreate(credential, prfSalt, rpId, signal);
  }
  throw new PrfCeremonyError(
    "prf_missing_output",
    "This authenticator did not return a WebAuthn PRF result, so it cannot seal a vault. Windows Hello often does not support PRF — choose a security key, or seal with a PIN.",
  );
}

/**
 * Attachment is named only when the person chose one. The credential id lives
 * in the vault header and every unlock names it, so a security key's limited
 * resident slots buy nothing and it is asked for a non-resident credential.
 * User verification stays required in create and get alike: a key derives a
 * different PRF secret with and without it.
 */
function authenticatorSelectionFor(
  attachment: PasskeyAttachment | undefined,
): AuthenticatorSelectionCriteria {
  const selection: AuthenticatorSelectionCriteria = {
    residentKey: attachment === "cross-platform" ? "discouraged" : "preferred",
    requireResidentKey: false,
    userVerification: "required",
  };
  if (attachment) selection.authenticatorAttachment = attachment;
  return selection;
}

export async function createPasskeyUnlockCeremonyDefault(
  rpId: string = webauthnRpId(),
  signal?: AbortSignal,
  options: PasskeyCreateOptions = {},
): Promise<PasskeyCeremony> {
  if (signal?.aborted) {
    throw new DOMException("The operation was aborted.", "AbortError");
  }
  if (publicKeyCredentialApi() === undefined) {
    throw new PrfCeremonyError(
      "unsupported",
      "This browser cannot create a passkey.",
    );
  }
  try {
    assertWebauthnHost();
  } catch (error) {
    mapHostError(error);
  }
  // Unpredictable per-credential PRF input (WebAuthn L3). Not a fixed domain string.
  const prfSalt = randomBytes(32);
  const userId = randomBytes(16);
  let result: Credential | null;
  try {
    result = await requireCredentials().create({
      publicKey: {
        challenge: overlapCast(randomBytes(32)),
        rp: { id: rpId, name: "OpenSesame" },
        user: {
          id: overlapCast(userId),
          name: "vault-unlock",
          displayName: "OpenSesame vault unlock",
        },
        pubKeyCredParams: [
          { type: "public-key", alg: -7 },
          { type: "public-key", alg: -257 },
        ],
        authenticatorSelection: authenticatorSelectionFor(options.attachment),
        timeout: 120_000,
        extensions: overlapCast({
          prf: { eval: { first: prfSalt } },
        }),
      },
      ...(signal ? { signal } : undefined),
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw error;
    }
    if (error instanceof DOMException && error.name === "NotAllowedError") {
      throw new PrfCeremonyError("canceled", describeWebauthnError(error));
    }
    throw new PrfCeremonyError("unsupported", describeWebauthnError(error));
  }
  if (!result) {
    throw new PrfCeremonyError("canceled", "Passkey creation was cancelled.");
  }
  if (!isPublicKeyCredential(result)) {
    throw new PrfCeremonyError(
      "unsupported",
      "Passkey creation returned an unexpected credential type.",
    );
  }
  const credential = result;
  const createAssert: CeremonyClientDataAssert = { rpId, expectCreate: true };
  assertCeremonyClientData(credential, createAssert);
  const prfOutput = await prfOutputForNewCredential(
    credential,
    prfSalt,
    rpId,
    signal,
  );
  return { credential, prfOutput, prfSalt, userId };
}

function assertCeremonyRecords(
  records: PasskeyUnlockRecord[],
  options: PasskeyCeremonyGetOptions,
): PasskeyUnlockRecord[] {
  if (records.length === 0) {
    throw new PrfCeremonyError(
      "unsupported",
      "No passkey unlock records are enrolled.",
    );
  }
  if (options.signal?.aborted) {
    throw new DOMException("The operation was aborted.", "AbortError");
  }
  if (publicKeyCredentialApi() === undefined) {
    throw new PrfCeremonyError(
      "unsupported",
      "This browser cannot use a passkey.",
    );
  }
  try {
    assertWebauthnHost();
  } catch (error) {
    mapHostError(error);
  }
  const allowed = options.credentialIdB64
    ? records.filter((row) => row.credentialIdB64 === options.credentialIdB64)
    : records;
  if (allowed.length === 0) {
    throw new PrfCeremonyError(
      "wrong_credential",
      "That passkey is not enrolled for this vault.",
    );
  }
  return allowed;
}

function buildPrfGetRequest(
  allowed: PasskeyUnlockRecord[],
  rpId: string,
  signal: AbortSignal | undefined,
): CredentialRequestOptions {
  const allowCredentials: PublicKeyCredentialDescriptor[] = allowed.map(
    (row) => {
      const idBytes = b64ToBytes(row.credentialIdB64);
      // SAFETY: WebAuthn accepts BufferSource; Uint8Array is a BufferSource.
      const id: BufferSource = idBytes;
      return { type: "public-key", id };
    },
  );
  const evalByCredential: Record<string, { first: Uint8Array }> = {};
  for (const row of allowed) {
    evalByCredential[toWebauthnBase64Url(row.credentialIdB64)] = {
      first: b64ToBytes(row.prfSaltB64),
    };
  }
  const single = allowed[0];
  if (single === undefined) {
    throw new PrfCeremonyError(
      "unsupported",
      "No passkey unlock records are enrolled.",
    );
  }
  const prfExtension =
    allowed.length === 1
      ? { eval: { first: b64ToBytes(single.prfSaltB64) } }
      : { evalByCredential };
  return {
    publicKey: {
      challenge: overlapCast(randomBytes(32)),
      rpId,
      allowCredentials,
      userVerification: "required",
      timeout: 120_000,
      extensions: overlapCast({ prf: prfExtension }),
    },
    ...(signal ? { signal } : undefined),
  };
}

async function getPasskeyCredential(
  request: CredentialRequestOptions,
): Promise<PublicKeyCredential> {
  let result: Credential | null;
  try {
    result = await requireCredentials().get(request);
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw error;
    }
    if (error instanceof DOMException && error.name === "NotAllowedError") {
      throw new PrfCeremonyError("canceled", describeWebauthnError(error));
    }
    throw new PrfCeremonyError("unsupported", describeWebauthnError(error));
  }
  if (!result) {
    throw new PrfCeremonyError("canceled", "Passkey unlock was cancelled.");
  }
  if (!isPublicKeyCredential(result)) {
    throw new PrfCeremonyError(
      "unsupported",
      "Passkey unlock returned an unexpected credential type.",
    );
  }
  return result;
}

function matchCeremonyRecord(
  allowed: PasskeyUnlockRecord[],
  credential: PublicKeyCredential,
  selectedId: string | undefined,
): PasskeyUnlockRecord {
  const credentialIdB64 = bytesToB64(new Uint8Array(credential.rawId));
  const record =
    allowed.find((row) => row.credentialIdB64 === credentialIdB64) ?? null;
  if (!record || !credentialIdMatches(credential, record.credentialIdB64)) {
    throw new PrfCeremonyError(
      "wrong_credential",
      "A different passkey answered than the one enrolled for this vault.",
    );
  }
  if (selectedId && record.credentialIdB64 !== selectedId) {
    throw new PrfCeremonyError(
      "wrong_credential",
      "A different passkey answered than the one selected for unlock.",
    );
  }
  return record;
}

export async function getPasskeyUnlockCeremonyForDefault(
  records: PasskeyUnlockRecord[],
  options: PasskeyCeremonyGetOptions = {},
): Promise<PasskeyUnlockCeremonyResult> {
  const allowed = assertCeremonyRecords(records, options);
  const rpId = options.rpId ?? webauthnRpId();
  const credential = await getPasskeyCredential(
    buildPrfGetRequest(allowed, rpId, options.signal),
  );
  assertCeremonyClientData(credential, { rpId, expectCreate: false });
  const record = matchCeremonyRecord(
    allowed,
    credential,
    options.credentialIdB64,
  );
  const prfOutput = requirePrfOutputFromExtension(
    credential.getClientExtensionResults(),
  );
  return {
    prfOutput,
    record,
    credentialIdB64: bytesToB64(new Uint8Array(credential.rawId)),
  };
}

export async function getPasskeyUnlockCeremonyDefault(
  record: PasskeyUnlockRecord,
  rpId: string = webauthnRpId(),
  signal?: AbortSignal,
): Promise<ArrayBuffer> {
  const getOptions: PasskeyCeremonyGetOptions = {
    rpId,
    signal,
    credentialIdB64: record.credentialIdB64,
  };
  const selected = await getPasskeyUnlockCeremonyForDefault(
    [record],
    getOptions,
  );
  return selected.prfOutput;
}
