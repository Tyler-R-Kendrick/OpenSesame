/**
 * WebAuthn PRF unlock ceremonies (create / get) with exact credential selection.
 * Failed ceremonies throw typed errors and never touch unlock wraps (KP-23).
 */

import { isString, overlapCast } from "@opensesame/os-domain";
import {
  isPublicKeyCredential,
  maybePage,
  pageOrigin,
  publicKeyCredentialApi,
  requireCredentials,
} from "../../../../ports.js";
import { b64ToBytes, bytesToB64, randomBytes } from "../../crypto.js";
import {
  type PasskeyCeremony,
  type PasskeyUnlockCeremonyResult,
  type PasskeyUnlockRecord,
  WebauthnHostError,
  assertWebauthnHost,
  describeWebauthnError,
  webauthnRpId,
} from "../../unlock-methods.js";
import {
  PrfCeremonyError,
  requirePrfOutputFromExtension,
} from "./webauthn-prf-output.js";

export type PasskeyCeremonyGetOptions = {
  rpId?: string;
  signal?: AbortSignal | undefined;
  credentialIdB64?: string;
};

type CeremonyClientDataAssert = {
  rpId: string;
  expectCreate: boolean;
};

type CeremonyClientData = {
  type?: string;
  origin?: string;
  rpId?: string;
};

function readCeremonyClientData(
  credential: PublicKeyCredential,
): CeremonyClientData | null {
  const response = credential.response;
  if (response === undefined || response === null) return null;
  if (!("clientDataJSON" in response)) return null;
  try {
    const parsed = overlapCast(
      JSON.parse(new TextDecoder().decode(response.clientDataJSON)),
    );
    const data: CeremonyClientData = {};
    if (isString(parsed.type)) data.type = parsed.type;
    if (isString(parsed.origin)) data.origin = parsed.origin;
    if (isString(parsed.rpId)) data.rpId = parsed.rpId;
    return data;
  } catch {
    return null;
  }
}

function expectedWebauthnOrigin(): string {
  return maybePage()?.location.origin ?? "http://localhost";
}

function assertCeremonyClientData(
  credential: PublicKeyCredential,
  options: CeremonyClientDataAssert,
): void {
  const data = readCeremonyClientData(credential);
  if (!data) return;
  const expectedType = options.expectCreate
    ? "webauthn.create"
    : "webauthn.get";
  if (data.type && data.type !== expectedType) {
    throw new PrfCeremonyError(
      "wrong_rp",
      `Passkey ceremony type was ${data.type}, expected ${expectedType}.`,
    );
  }
  const expectedOrigin = expectedWebauthnOrigin();
  if (data.origin && data.origin !== expectedOrigin) {
    throw new PrfCeremonyError(
      "origin_mismatch",
      `Passkey origin was ${data.origin}, expected ${expectedOrigin}.`,
    );
  }
  if (data.rpId && data.rpId !== options.rpId) {
    throw new PrfCeremonyError(
      "wrong_rp",
      `Passkey RP id was ${data.rpId}, expected ${options.rpId}.`,
    );
  }
}

function credentialIdMatches(
  credential: PublicKeyCredential,
  credentialIdB64: string,
): boolean {
  return bytesToB64(new Uint8Array(credential.rawId)) === credentialIdB64;
}

/** Convert our standard btoa id into the base64url form WebAuthn maps use. */
function toWebauthnBase64Url(standardB64: string): string {
  return standardB64
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/u, "");
}

function mapHostError<Thrown>(error: Thrown): never {
  if (error instanceof WebauthnHostError) {
    throw new PrfCeremonyError("invalid_host", error.message);
  }
  throw error;
}

export async function createPasskeyUnlockCeremonyDefault(
  rpId: string = webauthnRpId(),
  signal?: AbortSignal,
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
        authenticatorSelection: {
          residentKey: "preferred",
          requireResidentKey: false,
          userVerification: "required",
        },
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
  const prfOutput = requirePrfOutputFromExtension(
    credential.getClientExtensionResults(),
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
