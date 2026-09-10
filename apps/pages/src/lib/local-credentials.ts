import {
  type BoundaryValue,
  isJsonObject,
  isNumber,
  isString,
} from "@opensesame/os-domain";
import { kvRefresh } from "./kv.js";
import {
  LocalDirectoryError,
  readLocalDirectory,
  withLocalDirectoryLock,
} from "./local-directory.js";
import { notifyLocalIamChange } from "./local-iam-events.js";
import { VfsError, readFile, tombFileKey, writeFile } from "./vfs.js";

const PATH = "config/identity-credentials";
const MAX_BYTES = 4_000_000;
export type LocalPasskey = {
  principalId: string;
  credentialId: string;
  publicKeyB64: string;
  counter: number;
  createdAt: number;
};

function base64url(value: BoundaryValue, max: number): value is string {
  return (
    isString(value) &&
    value.length > 0 &&
    value.length <= max &&
    /^[A-Za-z0-9_-]+$/.test(value)
  );
}

function isPasskey(value: BoundaryValue): value is LocalPasskey {
  return (
    isJsonObject(value) &&
    isString(value.principalId) &&
    /^local_[0-9a-f-]{36}$/.test(value.principalId) &&
    base64url(value.credentialId, 2048) &&
    base64url(value.publicKeyB64, 8192) &&
    isNumber(value.counter) &&
    Number.isSafeInteger(value.counter) &&
    value.counter >= 0 &&
    value.counter <= 0xffffffff &&
    isNumber(value.createdAt) &&
    Number.isSafeInteger(value.createdAt) &&
    value.createdAt > 0
  );
}

function parseCredentials(value: BoundaryValue): LocalPasskey[] {
  if (
    !isJsonObject(value) ||
    value.version !== 1 ||
    !Array.isArray(value.passkeys) ||
    value.passkeys.length > 1000 ||
    !value.passkeys.every(isPasskey) ||
    new Set(value.passkeys.map((key) => key.credentialId)).size !==
      value.passkeys.length
  )
    throw new LocalDirectoryError(
      "Invalid local credentials. Restore a valid vault backup.",
    );
  return value.passkeys;
}

/** Call within the directory lock when evaluating authentication or changing keys. */
export async function readLocalPasskeys(tomb: string): Promise<LocalPasskey[]> {
  await kvRefresh(tombFileKey(tomb, PATH), 8_388_608);
  try {
    const bytes = await readFile(tomb, PATH);
    if (bytes.length > MAX_BYTES)
      throw new LocalDirectoryError(
        "Local credential storage exceeds its limit.",
      );
    const parsed: BoundaryValue = JSON.parse(new TextDecoder().decode(bytes));
    return parseCredentials(parsed);
  } catch (error) {
    if (error instanceof VfsError && error.code === "not-found") return [];
    throw error;
  }
}

export async function writeLocalPasskeys(
  tomb: string,
  passkeys: LocalPasskey[],
): Promise<void> {
  const record = { version: 1, passkeys };
  parseCredentials(record);
  const bytes = new TextEncoder().encode(JSON.stringify(record));
  if (bytes.length > MAX_BYTES)
    throw new LocalDirectoryError(
      "Local credential storage exceeds its limit.",
    );
  try {
    await writeFile(tomb, PATH, bytes);
  } finally {
    notifyLocalIamChange();
  }
}

export async function requireLocalPerson(tomb: string, principalId: string) {
  const directory = await readLocalDirectory(tomb);
  const person = directory.entries.find(
    (entry) =>
      entry.id === principalId && entry.kind === "person" && entry.enabled,
  );
  if (!person)
    throw new LocalDirectoryError("This identity is unavailable or disabled.");
  return person;
}

export async function revokeLocalPasskey(
  tomb: string,
  principalId: string,
  credentialId: string,
): Promise<void> {
  return withLocalDirectoryLock(tomb, async () => {
    const keys = await readLocalPasskeys(tomb);
    if (
      !keys.some(
        (key) =>
          key.principalId === principalId && key.credentialId === credentialId,
      )
    )
      throw new LocalDirectoryError("This credential is no longer available.");
    await writeLocalPasskeys(
      tomb,
      keys.filter((key) => key.credentialId !== credentialId),
    );
  });
}
