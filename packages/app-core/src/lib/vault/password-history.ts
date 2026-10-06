import {
  type VaultItem,
  completePassword,
  methodsOfType,
  producePassword,
} from "@opensesame/vault-core";
import { listLocalBackupTargets } from "../backup-target-local.js";
import { loadHistorySelections } from "../history-backups.js";
import { legacyPasswordDigestStore } from "./password-history-legacy.js";
import type { PasswordDigestStore } from "./password-history-types.js";

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

const memory = new Map<string, Set<string>>();
let installed: PasswordDigestStore | null = null;

/** The store digests rest in: the encrypted one while it is installed. */
function store(): PasswordDigestStore {
  return installed ?? legacyPasswordDigestStore;
}

/** Route digests to `next`, or back to the device-sealed database with null. */
export function installPasswordDigestStore(
  next: PasswordDigestStore | null,
): void {
  installed = next;
}

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
    gone += (await store().forget(scope)) ?? 0;
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

/**
 * Where a password's history lives. A password method's history is its own;
 * the first method of an account keeps the item's scope (`<tomb>\0<item>`), so
 * a login migrated to an account (ADR 0172) keeps the digests it already had.
 */
function methodScope(tomb: string, itemId: string, methodId: string): string {
  const item = `${tomb}\u0000${itemId}`;
  return methodId === `${itemId}:password` ? item : `${item}\u0000${methodId}`;
}

/**
 * The passwords an item holds in the clear, by history scope. A peppered or
 * Sphinx password has none: it records no plaintext history at all (ADR 0172
 * §4), so its digest is neither checked nor stored.
 */
function heldSecrets(
  tomb: string,
  item: VaultItem | undefined,
): Map<string, string> {
  const held = new Map<string, string>();
  if (item === undefined) return held;
  if (item.kind === "account") {
    for (const method of methodsOfType(item, "password")) {
      held.set(
        methodScope(tomb, item.id, method.id),
        completePassword(producePassword(method)) ?? "",
      );
    }
  } else if (item.kind === "credential") {
    // History follows the password, wherever it is written from: one bound to
    // an account is kept in that account's scope, as the account reads it
    // (ADR 0179), and one kept on its own in its own.
    if (item.method.type === "password") {
      held.set(
        item.accountId === null
          ? `${tomb}\u0000${item.id}`
          : methodScope(tomb, item.accountId, item.method.id),
        completePassword(producePassword(item.method)) ?? "",
      );
    }
  } else if (item.kind === "secret") {
    held.set(`${tomb}\u0000${item.id}`, item.value);
  }
  return held;
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
    const before = heldSecrets(tomb, byId.get(item.id));
    for (const [scope, proposed] of heldSecrets(tomb, item)) {
      const previous = before.get(scope) ?? "";
      if (proposed === previous) continue;
      changes.push({ scope, previous, next: proposed });
    }
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

async function rememberDigest(scope: string, digest: string): Promise<void> {
  const known = scopeSet(scope);
  if (known.has(digest)) return;
  known.add(digest);
  await store().add(scope, digest);
}

async function digestsFor(scope: string): Promise<string[]> {
  return (await store().digestsFor(scope)) ?? [];
}
