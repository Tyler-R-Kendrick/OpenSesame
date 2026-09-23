/**
 * Pairwise SIOPv2 ES256 keys — one active key per (local subject, application).
 * Private JWK JSON lives only inside vault-encrypted VFS (`config/siop-keys`).
 */

import {
  type BoundaryValue,
  isJsonObject,
  isNumber,
  isString,
} from "@opensesame/os-domain";
import {
  type EcP256PublicJwk,
  ecP256JwkThumbprint,
  parsePublicEcP256Jwk,
} from "@opensesame/siop-v2";
import { kvRefresh } from "./kv.js";
import {
  LocalDirectoryError,
  withLocalDirectoryLock,
} from "./local-directory.js";
import { notifyLocalIamChange } from "./local-iam-events.js";
import { VfsError, readFile, tombFileKey, writeFile } from "./vfs.js";

const PATH = "config/siop-keys";
const MAX_BYTES = 1_000_000;
const MAX_KEYS = 1000;
const LOCAL_ID = /^local_[0-9a-f-]{36}$/;

type SiopKeyRecord = {
  subjectId: string;
  applicationId: string;
  keyId: string;
  publicJwk: EcP256PublicJwk;
  /** Private JWK serialized as JSON; ciphertext is the vault VFS layer only. */
  privateJwkJson: string;
  createdAt: number;
  revokedAt: number | null;
};

export type SiopPublicIdentity = {
  subjectId: string;
  applicationId: string;
  keyId: string;
  publicJwk: EcP256PublicJwk;
  createdAt: number;
};

function refused(message = "SIOP key material is unavailable."): never {
  throw new LocalDirectoryError(message);
}

function localId(value: BoundaryValue): value is string {
  return isString(value) && LOCAL_ID.test(value);
}

function isPrivateJwkJson(value: string): boolean {
  if (value.length === 0 || value.length > 4096) return false;
  try {
    const parsed: BoundaryValue = JSON.parse(value);
    return (
      isJsonObject(parsed) &&
      parsed.kty === "EC" &&
      parsed.crv === "P-256" &&
      isString(parsed.x) &&
      isString(parsed.y) &&
      isString(parsed.d) &&
      parsed.d.length >= 40 &&
      parsed.d.length <= 64
    );
  } catch {
    return false;
  }
}

function readStoredPublicJwk(value: BoundaryValue): EcP256PublicJwk | null {
  if (!isJsonObject(value)) return null;
  try {
    return parsePublicEcP256Jwk(value);
  } catch {
    return null;
  }
}

function parseRecord(value: BoundaryValue): SiopKeyRecord | null {
  if (!isJsonObject(value)) return null;
  if (!localId(value.subjectId) || !localId(value.applicationId)) return null;
  if (!isString(value.keyId) || !/^[A-Za-z0-9_-]{43}$/.test(value.keyId))
    return null;
  const privateJwkRaw = isString(value.privateJwkJson)
    ? value.privateJwkJson
    : isString(value.encryptedPrivateJwk)
      ? value.encryptedPrivateJwk
      : null;
  if (!privateJwkRaw || !isPrivateJwkJson(privateJwkRaw)) return null;
  if (
    !isNumber(value.createdAt) ||
    !Number.isSafeInteger(value.createdAt) ||
    value.createdAt <= 0
  )
    return null;
  if (
    value.revokedAt !== null &&
    !(
      isNumber(value.revokedAt) &&
      Number.isSafeInteger(value.revokedAt) &&
      value.revokedAt >= value.createdAt
    )
  )
    return null;
  const publicJwk = readStoredPublicJwk(value.publicJwk);
  if (!publicJwk) return null;
  return {
    subjectId: value.subjectId,
    applicationId: value.applicationId,
    keyId: value.keyId,
    publicJwk,
    privateJwkJson: privateJwkRaw,
    createdAt: value.createdAt,
    revokedAt: value.revokedAt === null ? null : value.revokedAt,
  };
}

function toPublic(record: SiopKeyRecord): SiopPublicIdentity {
  return {
    subjectId: record.subjectId,
    applicationId: record.applicationId,
    keyId: record.keyId,
    publicJwk: record.publicJwk,
    createdAt: record.createdAt,
  };
}

async function readRecords(tomb: string): Promise<SiopKeyRecord[]> {
  await kvRefresh(tombFileKey(tomb, PATH), MAX_BYTES * 2);
  try {
    const bytes = await readFile(tomb, PATH);
    if (bytes.length > MAX_BYTES)
      refused("SIOP key storage exceeds its limit.");
    const value: BoundaryValue = JSON.parse(new TextDecoder().decode(bytes));
    if (
      !isJsonObject(value) ||
      value.version !== 1 ||
      !Array.isArray(value.keys) ||
      value.keys.length > MAX_KEYS
    )
      refused("Invalid SIOP key storage. Restore a valid vault backup.");
    const keys: SiopKeyRecord[] = [];
    for (const row of value.keys) {
      const parsed = parseRecord(row);
      if (!parsed)
        refused("Invalid SIOP key storage. Restore a valid vault backup.");
      keys.push(parsed);
    }
    return keys;
  } catch (error) {
    if (error instanceof VfsError && error.code === "not-found") return [];
    throw error;
  }
}

async function writeRecords(
  tomb: string,
  keys: SiopKeyRecord[],
): Promise<void> {
  const bytes = new TextEncoder().encode(JSON.stringify({ version: 1, keys }));
  if (keys.length > MAX_KEYS || bytes.length > MAX_BYTES)
    refused("SIOP key capacity reached.");
  try {
    await writeFile(tomb, PATH, bytes);
  } finally {
    notifyLocalIamChange();
  }
}

function findActive(
  keys: SiopKeyRecord[],
  subjectId: string,
  applicationId: string,
): SiopKeyRecord | undefined {
  return keys.find(
    (row) =>
      row.subjectId === subjectId &&
      row.applicationId === applicationId &&
      row.revokedAt === null,
  );
}

async function mintPair() {
  const pair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const publicRaw = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const privateRaw = await crypto.subtle.exportKey("jwk", pair.privateKey);
  if (!isString(publicRaw.x) || !isString(publicRaw.y)) refused();
  if (
    !isString(privateRaw.d) ||
    !isString(privateRaw.x) ||
    !isString(privateRaw.y)
  )
    refused();
  const publicJwk = parsePublicEcP256Jwk({
    kty: "EC",
    crv: "P-256",
    x: publicRaw.x,
    y: publicRaw.y,
    alg: "ES256",
  });
  const privateJwkJson = JSON.stringify({
    kty: "EC",
    crv: "P-256",
    x: privateRaw.x,
    y: privateRaw.y,
    d: privateRaw.d,
    alg: "ES256",
  });
  if (!isPrivateJwkJson(privateJwkJson)) refused();
  return {
    publicJwk,
    privateJwkJson,
    keyId: await ecP256JwkThumbprint(publicJwk),
  };
}

/** Caller must hold {@link withLocalDirectoryLock} for this tomb. */
async function mintActiveSiopKey(
  tomb: string,
  subjectId: string,
  applicationId: string,
): Promise<SiopPublicIdentity> {
  if (!localId(subjectId) || !localId(applicationId)) refused();
  const keys = await readRecords(tomb);
  const existing = findActive(keys, subjectId, applicationId);
  if (existing) return toPublic(existing);
  const minted = await mintPair();
  const record: SiopKeyRecord = {
    subjectId,
    applicationId,
    keyId: minted.keyId,
    publicJwk: minted.publicJwk,
    privateJwkJson: minted.privateJwkJson,
    createdAt: Date.now(),
    revokedAt: null,
  };
  await writeRecords(tomb, [...keys, record]);
  return toPublic(record);
}

/**
 * Ensure a pairwise active key while the directory fence is already held.
 * Used from SIOP approval inside {@link withLocalIdentitySession}.
 */
export async function ensureSiopKeyInDirectoryFence(
  tomb: string,
  subjectId: string,
  applicationId: string,
): Promise<SiopPublicIdentity> {
  const active = await getActivePublicIdentity(tomb, subjectId, applicationId);
  if (active) return active;
  return mintActiveSiopKey(tomb, subjectId, applicationId);
}

/** Ensure a pairwise active key exists; never returns private material. */
export async function ensureSiopKey(
  tomb: string,
  subjectId: string,
  applicationId: string,
): Promise<SiopPublicIdentity> {
  const active = await getActivePublicIdentity(tomb, subjectId, applicationId);
  if (active) return active;
  return withLocalDirectoryLock(tomb, () =>
    mintActiveSiopKey(tomb, subjectId, applicationId),
  );
}

/** Public projection only — private JWK must never appear here. */
export async function getActivePublicIdentity(
  tomb: string,
  subjectId: string,
  applicationId: string,
): Promise<SiopPublicIdentity | null> {
  if (!localId(subjectId) || !localId(applicationId)) return null;
  const active = findActive(await readRecords(tomb), subjectId, applicationId);
  return active ? toPublic(active) : null;
}

/**
 * Import the active private key as a non-extractable CryptoKey for JOSE signing.
 * Callers must not log or serialize the returned key.
 */
export async function importSiopSigningKey(
  tomb: string,
  subjectId: string,
  applicationId: string,
): Promise<CryptoKey> {
  if (!localId(subjectId) || !localId(applicationId)) refused();
  const active = findActive(await readRecords(tomb), subjectId, applicationId);
  if (!active) refused();
  const parsed: BoundaryValue = JSON.parse(active.privateJwkJson);
  if (
    !isJsonObject(parsed) ||
    !isString(parsed.d) ||
    !isString(parsed.x) ||
    !isString(parsed.y)
  )
    refused();
  return crypto.subtle.importKey(
    "jwk",
    {
      kty: "EC",
      crv: "P-256",
      x: parsed.x,
      y: parsed.y,
      d: parsed.d,
    },
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
}

export async function rotateSiopKey(
  tomb: string,
  subjectId: string,
  applicationId: string,
): Promise<SiopPublicIdentity> {
  if (!localId(subjectId) || !localId(applicationId)) refused();
  return withLocalDirectoryLock(tomb, async () => {
    const keys = await readRecords(tomb);
    const now = Date.now();
    const next = keys.map((row) =>
      row.subjectId === subjectId &&
      row.applicationId === applicationId &&
      row.revokedAt === null
        ? { ...row, revokedAt: now }
        : row,
    );
    const minted = await mintPair();
    const record: SiopKeyRecord = {
      subjectId,
      applicationId,
      keyId: minted.keyId,
      publicJwk: minted.publicJwk,
      privateJwkJson: minted.privateJwkJson,
      createdAt: now,
      revokedAt: null,
    };
    await writeRecords(tomb, [...next, record]);
    return toPublic(record);
  });
}

export async function revokeSiopKey(
  tomb: string,
  subjectId: string,
  applicationId: string,
): Promise<void> {
  if (!localId(subjectId) || !localId(applicationId)) refused();
  await withLocalDirectoryLock(tomb, async () => {
    const keys = await readRecords(tomb);
    const active = findActive(keys, subjectId, applicationId);
    if (!active) refused("This SIOP key is no longer available.");
    const now = Date.now();
    await writeRecords(
      tomb,
      keys.map((row) =>
        row.subjectId === subjectId &&
        row.applicationId === applicationId &&
        row.revokedAt === null
          ? { ...row, revokedAt: now }
          : row,
      ),
    );
  });
}
