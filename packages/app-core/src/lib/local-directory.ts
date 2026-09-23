import {
  type BoundaryValue,
  isBoolean,
  isJsonObject,
  isNumber,
  isString,
} from "@opensesame/os-domain";
import { VaultCorruptError } from "@opensesame/vault-core";
import { lockManager } from "../ports.js";
import { kvRefresh } from "./kv.js";
import {
  changedMemberships,
  isMembership,
  validateDirectoryMemberships,
} from "./local-directory-memberships.js";
import {
  type LocalDirectory,
  type LocalDirectoryChange,
  LocalDirectoryError,
  type LocalIdentity,
  type LocalIdentityKind,
  type LocalMembership,
} from "./local-directory-types.js";
import { notifyLocalIamChange } from "./local-iam-events.js";
import { VfsError, readFile, tombFileKey, vfsSeams, writeFile } from "./vfs.js";

export const LOCAL_DIRECTORY_PATH = "config/identity-directory";
export {
  LocalDirectoryError,
  type LocalDirectory,
  type LocalDirectoryChange,
  type LocalIdentity,
  type LocalIdentityKind,
  type LocalMembership,
} from "./local-directory-types.js";

function isKind(value: BoundaryValue): value is LocalIdentityKind {
  return (
    value === "person" ||
    value === "agent" ||
    value === "application" ||
    value === "organization"
  );
}

function validName(value: BoundaryValue): value is string {
  return (
    isString(value) &&
    value.trim() === value &&
    value.length > 0 &&
    value.length <= 128 &&
    !/[\p{Cc}\p{Cf}]/u.test(value)
  );
}

function isEntry(value: BoundaryValue): value is LocalIdentity {
  return (
    isJsonObject(value) &&
    isString(value.id) &&
    /^local_[0-9a-f-]{36}$/.test(value.id) &&
    isKind(value.kind) &&
    validName(value.name) &&
    isBoolean(value.enabled)
  );
}

function parseDirectory(value: BoundaryValue): LocalDirectory {
  if (
    !isJsonObject(value) ||
    (value.version !== 1 && value.version !== 2) ||
    !Number.isSafeInteger(value.revision) ||
    !isNumber(value.revision) ||
    value.revision < 0 ||
    !Array.isArray(value.entries) ||
    value.entries.length > 1000 ||
    !value.entries.every(isEntry)
  ) {
    throw new LocalDirectoryError(
      "The local directory is invalid. Restore a valid vault backup before editing it.",
    );
  }
  const entries = value.entries;
  if (new Set(entries.map((entry) => entry.id)).size !== entries.length) {
    throw new LocalDirectoryError(
      "The local directory contains duplicate identities. Restore a valid backup.",
    );
  }
  const memberships = value.version === 1 ? [] : value.memberships;
  if (!Array.isArray(memberships) || !memberships.every(isMembership))
    throw new LocalDirectoryError(
      "Invalid organization memberships. Restore a valid backup.",
    );
  validateDirectoryMemberships(entries, memberships);
  return { version: 2, revision: value.revision, entries, memberships };
}

/** Local records are not credentials, remote principals, or resource grants. */
export async function readLocalDirectory(
  tomb: string,
): Promise<LocalDirectory> {
  await kvRefresh(tombFileKey(tomb, LOCAL_DIRECTORY_PATH), 1_048_576);
  try {
    const bytes = await readFile(tomb, LOCAL_DIRECTORY_PATH);
    if (bytes.length > 512_000)
      throw new LocalDirectoryError(
        "The local directory exceeds its size limit. Restore a smaller valid backup.",
      );
    const parsed: BoundaryValue = JSON.parse(new TextDecoder().decode(bytes));
    return parseDirectory(parsed);
  } catch (error) {
    if (error instanceof VfsError && error.code === "not-found") {
      return { version: 2, revision: 0, entries: [], memberships: [] };
    }
    // Ciphertext sealed under a destroyed guest key, not a parse failure.
    if (
      error instanceof VaultCorruptError ||
      (error instanceof VfsError && error.code === "corrupt")
    ) {
      await vfsSeams.deleteRaw(tombFileKey(tomb, LOCAL_DIRECTORY_PATH));
      return { version: 2, revision: 0, entries: [], memberships: [] };
    }
    throw error;
  }
}

function changedEntries(
  entries: LocalIdentity[],
  change: LocalDirectoryChange,
): LocalIdentity[] {
  if (change.action === "membership") return entries;
  if (change.action !== "delete" && !validName(change.name)) {
    throw new LocalDirectoryError(
      "Use a name of 1–128 characters without control characters.",
    );
  }
  if (change.action === "create") {
    if (!isKind(change.kind) || entries.length >= 1000)
      throw new LocalDirectoryError(
        "The directory is limited to 1,000 records. Remove an unused record before creating another.",
      );
    const id = change.id ?? `local_${crypto.randomUUID()}`;
    if (
      (change.id !== undefined && !/^local_[0-9a-f-]{36}$/.test(change.id)) ||
      entries.some((entry) => entry.id === id)
    )
      throw new LocalDirectoryError(
        "This identity already exists. Reload the directory.",
      );
    return [
      ...entries,
      {
        id,
        kind: change.kind,
        name: change.name,
        enabled: true,
      },
    ];
  }
  if (!entries.some((entry) => entry.id === change.id))
    throw new LocalDirectoryError(
      "This identity no longer exists. Reload the directory.",
    );
  if (change.action === "delete")
    return entries.filter((entry) => entry.id !== change.id);
  if (!isBoolean(change.enabled))
    throw new LocalDirectoryError(
      "Invalid identity state. Reload the directory.",
    );
  return entries.map((entry) =>
    entry.id === change.id
      ? { ...entry, name: change.name, enabled: change.enabled }
      : entry,
  );
}

/**
 * Internal commit primitive: callers must hold the directory/session fence
 * and have decided who may make the change — bootstrap for its own records,
 * an owner/admin session for memberships, `changeLocalDirectory`
 * (`local-directory-admin.ts`) for the Identity/Access panel.
 */
export async function commitLocalDirectoryUnderLock(
  tomb: string,
  revision: number,
  change: LocalDirectoryChange,
): Promise<LocalDirectory> {
  const current = await readLocalDirectory(tomb);
  if (current.revision === Number.MAX_SAFE_INTEGER)
    throw new LocalDirectoryError(
      "The directory revision limit has been reached. Restore a valid backup.",
    );
  if (current.revision !== revision)
    throw new LocalDirectoryError(
      "The directory changed in another tab. Reload before saving.",
    );
  const entries = changedEntries(current.entries, change);
  const next: LocalDirectory = {
    version: 2,
    revision: current.revision + 1,
    entries,
    memberships: changedMemberships(current, entries, change),
  };
  const bytes = new TextEncoder().encode(JSON.stringify(next));
  if (bytes.length > 512_000)
    throw new LocalDirectoryError(
      "The local directory exceeds its size limit.",
    );
  try {
    await writeFile(tomb, LOCAL_DIRECTORY_PATH, bytes);
  } finally {
    notifyLocalIamChange();
  }
  return next;
}

/** Directory, credential and session mutations share one cross-tab fence. */
export async function withLocalDirectoryLock<T>(
  tomb: string,
  action: () => Promise<T>,
): Promise<T> {
  // No unlocked-tab fallback: two editors must not silently overwrite each other.
  const locks = lockManager();
  if (!locks)
    throw new LocalDirectoryError(
      "This browser cannot safely edit the directory. Use a browser with Web Locks support.",
    );
  return locks.request(`opensesame-directory-${tomb}`, action);
}
