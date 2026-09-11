import {
  type BoundaryValue,
  type OrganizationRole,
  isBoolean,
  isJsonObject,
  isNumber,
  isString,
} from "@opensesame/os-domain";
import { kvRefresh } from "./kv.js";
import { notifyLocalIamChange } from "./local-iam-events.js";
import { VaultCorruptError } from "./vault/crypto.js";
import { VfsError, readFile, tombFileKey, vfsSeams, writeFile } from "./vfs.js";

export const LOCAL_DIRECTORY_PATH = "config/identity-directory";
export class LocalDirectoryError extends Error {
  readonly name = "LocalDirectoryError";
}
export type LocalIdentityKind =
  | "person"
  | "agent"
  | "application"
  | "organization";
export type LocalIdentity = {
  id: string;
  kind: LocalIdentityKind;
  name: string;
  enabled: boolean;
};
export type LocalDirectory = {
  version: 2;
  revision: number;
  entries: LocalIdentity[];
  memberships: LocalMembership[];
};
export type LocalMembership = {
  organizationId: string;
  principalId: string;
  role: OrganizationRole;
};

function isRole(value: BoundaryValue): value is OrganizationRole {
  return value === "owner" || value === "admin" || value === "member";
}

function isMembership(value: BoundaryValue): value is LocalMembership {
  return (
    isJsonObject(value) &&
    isString(value.organizationId) &&
    isString(value.principalId) &&
    isRole(value.role)
  );
}

function validateMemberships(
  entries: LocalIdentity[],
  memberships: LocalMembership[],
) {
  const ids = new Set<string>();
  if (memberships.length > 5000)
    throw new LocalDirectoryError(
      "The directory is limited to 5,000 memberships.",
    );
  for (const membership of memberships) {
    const org = entries.find((entry) => entry.id === membership.organizationId);
    const person = entries.find((entry) => entry.id === membership.principalId);
    const key = `${membership.organizationId}:${membership.principalId}`;
    if (
      ids.has(key) ||
      org?.kind !== "organization" ||
      !person ||
      (person.kind !== "person" && person.kind !== "agent") ||
      (person.kind === "agent" && membership.role !== "member")
    )
      throw new LocalDirectoryError("Invalid organization membership.");
    ids.add(key);
  }
  requireOwners(entries, memberships, memberships);
}

function requireOwners(
  entries: LocalIdentity[],
  memberships: LocalMembership[],
  previous: LocalMembership[],
) {
  for (const organizationId of new Set(
    previous.map((row) => row.organizationId),
  )) {
    if (!entries.some((entry) => entry.id === organizationId)) continue;
    if (
      !memberships.some(
        (row) =>
          row.organizationId === organizationId &&
          row.role === "owner" &&
          entries.some(
            (entry) =>
              entry.id === row.principalId &&
              entry.kind === "person" &&
              entry.enabled,
          ),
      )
    )
      throw new LocalDirectoryError(
        "Keep an enabled person as organization owner before removing or disabling the last owner.",
      );
  }
}

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
  validateMemberships(entries, memberships);
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

export type LocalDirectoryChange =
  | { action: "create"; kind: LocalIdentityKind; name: string; id?: string }
  | { action: "update"; id: string; name: string; enabled: boolean }
  | { action: "delete"; id: string }
  | {
      action: "membership";
      organizationId: string;
      principalId: string;
      role: OrganizationRole | null;
    };

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

function changedMemberships(
  current: LocalDirectory,
  entries: LocalIdentity[],
  change: LocalDirectoryChange,
) {
  let memberships = current.memberships.filter(
    (row) =>
      entries.some((entry) => entry.id === row.organizationId) &&
      entries.some((entry) => entry.id === row.principalId),
  );
  if (change.action === "membership") {
    if (change.role !== null && !isRole(change.role))
      throw new LocalDirectoryError("Invalid organization role.");
    memberships = memberships.filter(
      (row) =>
        row.organizationId !== change.organizationId ||
        row.principalId !== change.principalId,
    );
    if (change.role !== null)
      memberships.push({
        organizationId: change.organizationId,
        principalId: change.principalId,
        role: change.role,
      });
  }
  validateMemberships(entries, memberships);
  requireOwners(entries, memberships, current.memberships);
  return memberships;
}

export async function changeLocalDirectory(
  tomb: string,
  revision: number,
  change: LocalDirectoryChange,
): Promise<LocalDirectory> {
  return withLocalDirectoryLock(tomb, () =>
    commitLocalDirectoryUnderLock(tomb, revision, change),
  );
}

/** Internal commit primitive: callers must hold the directory/session fence. */
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
  if (!navigator.locks)
    throw new LocalDirectoryError(
      "This browser cannot safely edit the directory. Use a browser with Web Locks support.",
    );
  return navigator.locks.request(`opensesame-directory-${tomb}`, action);
}

export {
  GUEST_PERSON_NAME,
  PAGES_APPLICATION_ID,
  PAGES_APPLICATION_NAME,
  SUPPORT_AGENT_ID,
  SUPPORT_AGENT_NAME,
  currentOwnerPersonName,
  ensureOwnerPerson,
  ownerPersonName,
} from "./local-directory-bootstrap.js";
