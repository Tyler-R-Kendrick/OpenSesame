/**
 * Writing an account's credentials (ADR 0179): `splitAccount` keeps the methods
 * an account was written with as credentials bound to it, and
 * `extractEmbeddedMethods` does the same for an account that still carries them
 * (a body from before this ADR, or from a device that has not moved to it).
 */

import type { AccountItem, LoginMethod } from "./account.js";
import {
  type CredentialItem,
  type CredentialStamp,
  boundCredentialName,
  credentialBase,
  isAccount,
  isCredential,
} from "./credential.js";
import type { VaultItem } from "./model.js";

function sameMethod(a: LoginMethod, b: LoginMethod): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function bind(
  existing: CredentialItem | undefined,
  account: AccountItem,
  method: LoginMethod,
  index: number,
  stamp: CredentialStamp,
): CredentialItem {
  const name =
    existing?.named === true
      ? existing.name
      : boundCredentialName(account.name, method, account.methods);
  const next: CredentialItem = {
    ...credentialBase(method, stamp),
    kind: "credential",
    name,
    method,
    accountId: account.id,
    order: index,
    folderId: account.folderId,
  };
  if (existing === undefined) return next;
  if (existing.named === true) next.named = true;
  const unchanged =
    sameMethod(existing.method, method) &&
    existing.name === name &&
    existing.accountId === account.id &&
    existing.order === index &&
    existing.folderId === account.folderId &&
    existing.deletedAt === stamp.deletedAt;
  return unchanged
    ? existing
    : {
        ...existing,
        name,
        method,
        accountId: account.id,
        order: index,
        folderId: account.folderId,
        updatedAt: stamp.updatedAt,
        deletedAt: stamp.deletedAt,
      };
}

/**
 * Put `next` where its id is, or after `after` (or at the end for -1). Returns
 * the position the next one follows.
 */
function place(items: VaultItem[], next: VaultItem, after: number): number {
  const at = items.findIndex((item) => item.id === next.id);
  if (at >= 0) {
    items[at] = next;
    return Math.max(after, at);
  }
  if (after < 0) {
    items.push(next);
    return items.length - 1;
  }
  items.splice(after + 1, 0, next);
  return after + 1;
}

/**
 * The method with an id that is safe to keep as an item's. A method id was only
 * ever unique within its account; kept as an item it must not be one that some
 * other item holds, or a file naming a method after a note or another account's
 * credential would overwrite it. The method keeps its own id when nothing else
 * has it, or when it is already this account's credential; otherwise the id is
 * scoped to the account.
 */
function homed(
  items: readonly VaultItem[],
  accountId: string,
  method: LoginMethod,
  taken: ReadonlySet<string>,
): LoginMethod {
  const owner = (id: string) => items.find((item) => item.id === id);
  const free = (id: string) => owner(id) === undefined && !taken.has(id);
  const mine = (id: string) => {
    const item = owner(id);
    return (
      item !== undefined &&
      isCredential(item) &&
      item.accountId === accountId &&
      !taken.has(id)
    );
  };
  if (free(method.id) || mine(method.id)) return method;
  let candidate = `${accountId}:${method.id}`;
  for (let n = 2; !free(candidate) && !mine(candidate); n += 1) {
    candidate = `${accountId}:${method.id}:${n}`;
  }
  return { ...method, id: candidate };
}

function homedAll(
  items: readonly VaultItem[],
  accountId: string,
  methods: readonly LoginMethod[],
): LoginMethod[] {
  const taken = new Set<string>();
  return methods.map((method) => {
    const safe = homed(items, accountId, method, taken);
    taken.add(safe.id);
    return safe;
  });
}

export function credentialOf(
  items: readonly VaultItem[],
  id: string,
): CredentialItem | undefined {
  return items.find(
    (item): item is CredentialItem => isCredential(item) && item.id === id,
  );
}

/**
 * Write an account that carries its methods: the account is kept with none,
 * and each method is kept as a credential bound to it. A bound credential the
 * account no longer lists was removed from it, so it goes to the trash, where
 * it can be restored; it is not deleted outright and not left behind as a
 * password the person thinks is gone.
 */
export function splitAccount(
  items: readonly VaultItem[],
  account: AccountItem,
  now: string,
): VaultItem[] {
  const out = [...items];
  const methods = homedAll(out, account.id, account.methods);
  const whole: AccountItem = { ...account, methods };
  let cursor = place(out, { ...account, methods: [] }, -1);
  methods.forEach((method, index) => {
    const existing = credentialOf(out, method.id);
    const stamp: CredentialStamp = {
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      deletedAt: account.deletedAt,
    };
    cursor = place(out, bind(existing, whole, method, index, stamp), cursor);
  });
  const kept = new Set(methods.map((method) => method.id));
  return out.map((item) =>
    isCredential(item) &&
    item.accountId === account.id &&
    item.deletedAt === null &&
    !kept.has(item.id)
      ? { ...item, deletedAt: now, updatedAt: now }
      : item,
  );
}

/** Whether any account in `items` still carries a method of its own. */
export function hasEmbeddedMethods(items: readonly VaultItem[]): boolean {
  return items.some(
    (item) =>
      isAccount(item) && Array.isArray(item.methods) && item.methods.length > 0,
  );
}

/**
 * Move every method an account still carries into a credential. This is how a
 * vault written before ADR 0179 opens, and how an account arriving from a
 * device that has not yet is read: the credential takes the method's id, the
 * account's times and its folder, so two devices that do it make the same
 * credentials and a merge sees no difference. An existing credential of the
 * same id is kept when it changed after the account did. Idempotent.
 */
export function extractEmbeddedMethods(
  items: readonly VaultItem[],
): VaultItem[] {
  if (!hasEmbeddedMethods(items)) return [...items];
  const out = [...items];
  for (const item of items) {
    if (!isAccount(item) || item.methods.length === 0) continue;
    const methods = homedAll(out, item.id, item.methods);
    const whole: AccountItem = { ...item, methods };
    let cursor = place(out, { ...item, methods: [] }, -1);
    methods.forEach((method, index) => {
      const existing = credentialOf(out, method.id);
      if (existing !== undefined && existing.updatedAt > item.updatedAt) return;
      const next = bind(existing, whole, method, index, {
        createdAt: existing?.createdAt ?? item.createdAt,
        updatedAt: item.updatedAt,
        deletedAt: item.deletedAt,
      });
      cursor = place(out, next, cursor);
    });
  }
  return out;
}
