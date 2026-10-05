/**
 * Retired-password digests when no backup is configured.
 *
 * The store answers only whether a password was used before. A configured
 * backup is not opened: historical records are never read and never copied
 * here. Rows are sealed under the device at-rest key (ADR 0149). The
 * password itself is never stored.
 */

import {
  type BoundaryValue,
  isJsonObject,
  isString,
} from "@opensesame/os-domain";
import type { VaultItem } from "@opensesame/vault-core";
import { openOwnedDatabase } from "../../ports.js";
import { atRestBinding, openAtRest, sealAtRest } from "../at-rest/cipher.js";
import { type AtRestKey, atRestReady } from "../at-rest/key.js";
import { listLocalBackupTargets } from "../backup-target-local.js";
import { loadHistorySelections } from "../history-backups.js";
import { storageWritesHalted } from "../storage-halt.js";
import { PASSWORD_HISTORY_DATABASE } from "../storage-ownership.js";

export class PasswordUsedBeforeError extends Error {
  constructor() {
    super("That password was used before.");
    this.name = "PasswordUsedBeforeError";
  }
}

export type RetiredDigest = {
  scope: string;
  digest: string;
};

const DB_VERSION = 1;
const DIGESTS = "digests";
const memory = new Map<string, Set<string>>();

export function resetPasswordHistoryForTest(): void {
  memory.clear();
}

/**
 * Forget what is known about an item's retired passwords: an item that leaves
 * a vault for a trip (ADR 0171) must not stay recognisable by them. Resolves
 * with how many digests went.
 */
export async function forgetRetiredPasswords(
  tomb: string,
  itemIds: readonly string[],
): Promise<number> {
  let gone = 0;
  for (const id of itemIds) {
    const scope = `${tomb}\u0000${id}`;
    gone += memory.get(scope)?.size ?? 0;
    memory.delete(scope);
    gone +=
      (await withDb(async (db) => {
        const store = db.transaction(DIGESTS, "readwrite").objectStore(DIGESTS);
        const keys: IDBValidKey[] = await idbReq(
          store.index("by_scope").getAllKeys(scope),
        );
        for (const key of keys) await idbReq(store.delete(key));
        return keys.length;
      })) ?? 0;
  }
  return gone;
}

/** True only when a backup target is enabled or a history remote is bound. */
export function persistenceProvided(): boolean {
  try {
    if (listLocalBackupTargets().some((target) => target.enabled)) return true;
    return loadHistorySelections().some((row) =>
      Boolean(row.remote?.trim() || row.connectionId?.trim()),
    );
  } catch {
    return false;
  }
}

function concealedSecret(item: VaultItem | undefined): string {
  if (!item) return "";
  if (item.kind === "login") return item.password;
  if (item.kind === "secret") return item.value;
  return "";
}

type PasswordChange = {
  scope: string;
  previous: string;
  next: string;
};

function passwordChanges(
  tomb: string,
  current: readonly VaultItem[],
  next: readonly VaultItem[],
): PasswordChange[] {
  const byId = new Map(current.map((item) => [item.id, item]));
  const changes: PasswordChange[] = [];
  for (const item of next) {
    const previous = concealedSecret(byId.get(item.id));
    const proposed = concealedSecret(item);
    if (proposed === previous) continue;
    changes.push({
      scope: `${tomb}\u0000${item.id}`,
      previous,
      next: proposed,
    });
  }
  return changes;
}

async function digestPassword(password: string): Promise<string> {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(password),
  );
  return [...new Uint8Array(bytes)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function isDigest(value: string): boolean {
  return /^[0-9a-f]{64}$/.test(value);
}

/**
 * Refuse a proposed password whose digest is already retired. Returns the
 * digests to record only after the vault write commits.
 */
export async function preparePasswordRetirement(
  tomb: string,
  current: readonly VaultItem[],
  next: readonly VaultItem[],
): Promise<RetiredDigest[]> {
  const changes = passwordChanges(tomb, current, next);
  if (changes.length === 0 || persistenceProvided()) return [];
  for (const change of changes) {
    if (!change.next) continue;
    if (await passwordPreviouslyUsed(change.scope, change.next)) {
      throw new PasswordUsedBeforeError();
    }
  }
  const retired: RetiredDigest[] = [];
  for (const change of changes) {
    if (!change.previous) continue;
    retired.push({
      scope: change.scope,
      digest: await digestPassword(change.previous),
    });
  }
  return retired;
}

export async function rememberRetiredDigests(
  notes: readonly RetiredDigest[],
): Promise<void> {
  if (notes.length === 0 || persistenceProvided()) return;
  for (const note of notes) await rememberDigest(note.scope, note.digest);
}

/** Record a retired password's digest. No-op when a backup is configured. */
export async function noteRetiredPassword(
  scope: string,
  password: string,
): Promise<void> {
  if (!password || persistenceProvided()) return;
  await rememberDigest(scope, await digestPassword(password));
}

/** Hash equality only. Never reads a historical password record. */
export async function passwordPreviouslyUsed(
  scope: string,
  password: string,
): Promise<boolean> {
  if (!password || persistenceProvided()) return false;
  const digest = await digestPassword(password);
  if (memory.get(scope)?.has(digest)) return true;
  const stored = await digestsFor(scope);
  return stored.includes(digest);
}

function scopeSet(scope: string): Set<string> {
  const found = memory.get(scope);
  if (found) return found;
  const created = new Set<string>();
  memory.set(scope, created);
  return created;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = openOwnedDatabase(PASSWORD_HISTORY_DATABASE, DB_VERSION);
    req.onerror = () => reject(req.error ?? new Error("indexedDB open failed"));
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(DIGESTS)) {
        const store = db.createObjectStore(DIGESTS, { keyPath: "id" });
        store.createIndex("by_scope", "scope", { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
  });
}

function idbReq<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error("indexedDB request failed"));
  });
}

function rowBinding(id: string): Uint8Array {
  return atRestBinding(`idb.${PASSWORD_HISTORY_DATABASE}.${DIGESTS}`, id);
}

async function withDb<T>(
  run: (db: IDBDatabase, atRest: AtRestKey) => Promise<T>,
): Promise<T | undefined> {
  if (storageWritesHalted()) return undefined;
  try {
    const atRest = await atRestReady();
    if (!atRest.durable) return undefined;
    const db = await openDb();
    try {
      return await run(db, atRest);
    } finally {
      db.close();
    }
  } catch {
    return undefined;
  }
}

async function rememberDigest(scope: string, digest: string): Promise<void> {
  const known = scopeSet(scope);
  if (known.has(digest)) return;
  known.add(digest);
  await withDb(async (db, atRest) => {
    const id = crypto.randomUUID();
    const tx = db.transaction(DIGESTS, "readwrite");
    await idbReq(
      tx.objectStore(DIGESTS).put({
        id,
        scope,
        sealed: sealAtRest(atRest.key, rowBinding(id), digest),
      }),
    );
  });
}

function openDigest(atRest: AtRestKey, row: BoundaryValue): string | null {
  if (!isJsonObject(row) || !isString(row.id) || !isString(row.sealed)) {
    return null;
  }
  const text = openAtRest(atRest.key, rowBinding(row.id), row.sealed);
  return text !== null && isDigest(text) ? text : null;
}

async function digestsFor(scope: string): Promise<string[]> {
  const rows = await withDb(async (db, atRest) => {
    const tx = db.transaction(DIGESTS, "readonly");
    const stored: BoundaryValue[] = await idbReq(
      tx.objectStore(DIGESTS).index("by_scope").getAll(scope),
    );
    return stored
      .map((row) => openDigest(atRest, row))
      .filter((digest): digest is string => digest !== null);
  });
  return rows ?? [];
}
