/**
 * Credentials are entries of their own (ADR 0179).
 *
 * A password, an API key, a token, an OAuth client and an authenticator are
 * each an item in the vault, with the type's own list row, detail page and
 * switch in Settings › Vaults › Item types. An account does not hold them: it
 * is *bound* to them by reference (`accountId`). A credential bound to no
 * account is a credential too: a password generated and kept for nothing in
 * particular.
 *
 * `AccountItem.methods` stays as the shape every reader of an account already
 * knows, but only as a view. `resolveAccounts` fills it from the bound
 * credentials when the store hands items to a surface, and `splitAccount`
 * turns an account written with methods back into credentials. A sealed body
 * never holds a method inside an account after `extractEmbeddedMethods` has
 * run, so no reader of a body has two places to look.
 */

import {
  type AccountItem,
  LOGIN_METHOD_TYPES,
  type LoginMethod,
  type LoginMethodType,
  newMethodId,
} from "./account.js";
import type { BaseItem, VaultItem } from "./model.js";

export const CREDENTIAL_TYPE_IDS = [
  "password",
  "api-key",
  "token",
  "oauth-client",
  "authenticator",
] as const;
export type CredentialTypeId = (typeof CREDENTIAL_TYPE_IDS)[number];

const TYPE_ID_OF = {
  password: "password",
  "api-key": "api-key",
  token: "token",
  oauth: "oauth-client",
  authenticator: "authenticator",
} satisfies Record<LoginMethodType, CredentialTypeId>;

const LABEL_OF = {
  password: "Password",
  "api-key": "API key",
  token: "Token",
  oauth: "OAuth client",
  authenticator: "Authenticator",
} satisfies Record<LoginMethodType, string>;

/** The item type a login method type is kept as. */
export function credentialTypeId(type: LoginMethodType): CredentialTypeId {
  return TYPE_ID_OF[type];
}

/** The login method type a credential type id holds, or undefined for any other id. */
export function loginMethodTypeOf(id: string): LoginMethodType | undefined {
  return LOGIN_METHOD_TYPES.find((type) => TYPE_ID_OF[type] === id);
}

export function isCredentialTypeId(id: string): id is CredentialTypeId {
  return loginMethodTypeOf(id) !== undefined;
}

export function credentialTypeLabel(type: LoginMethodType): string {
  return LABEL_OF[type];
}

/**
 * A credential: one login method, kept as an item. `method.id` is the item's
 * id, so a method keeps the id it always had when it is moved out of an
 * account and two devices that do it agree.
 */
export type CredentialItem = BaseItem & {
  kind: "credential";
  method: LoginMethod;
  /** The account it opens, or null for a credential kept on its own. */
  accountId: string | null;
  /** Its place among the account's credentials. */
  order?: number | undefined;
  /**
   * The person named it. A credential bound to an account is otherwise named
   * after it ("Billing · API key") and follows it when it is renamed.
   */
  named?: boolean | undefined;
};

export function isCredential(item: VaultItem): item is CredentialItem {
  return item.kind === "credential";
}

export function isAccount(item: VaultItem): item is AccountItem {
  return item.kind === "account";
}

/** When a credential was made, last changed and trashed. */
export type CredentialStamp = {
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
};

/** Everything a credential item needs beyond what its method says. */
export function credentialBase(
  method: LoginMethod,
  stamp: CredentialStamp,
): BaseItem {
  return {
    id: method.id,
    kind: "credential",
    name: "",
    folderId: null,
    favorite: false,
    notes: "",
    fields: [],
    ...stamp,
  };
}

/** A new credential of its own, bound to `accountId` or to nothing. */
export function createCredential(
  method: LoginMethod,
  name: string,
  accountId: string | null = null,
  now = new Date().toISOString(),
): CredentialItem {
  return {
    ...credentialBase(method, {
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    }),
    kind: "credential",
    name,
    method,
    accountId,
  };
}

/** A fresh id for a method that will be kept as a credential. */
export function newCredentialId(type: LoginMethodType, owner: string): string {
  return newMethodId(owner, type);
}

/** "Billing API · API key", numbered when an account holds several of a type. */
export function boundCredentialName(
  accountName: string,
  method: LoginMethod,
  methods: readonly LoginMethod[],
): string {
  const same = methods.filter((other) => other.type === method.type);
  const label = LABEL_OF[method.type];
  const numbered =
    same.length > 1 ? `${label} ${same.indexOf(method) + 1}` : label;
  return accountName.trim() === "" ? numbered : `${accountName} · ${numbered}`;
}

/** Whether a credential opens something that is still there. */
export function isBound(
  credential: CredentialItem,
  accounts: ReadonlySet<string>,
): boolean {
  return credential.accountId !== null && accounts.has(credential.accountId);
}

function orderOf(credential: CredentialItem): number {
  return credential.order ?? Number.MAX_SAFE_INTEGER;
}

function byPlace(a: CredentialItem, b: CredentialItem): number {
  return (
    orderOf(a) - orderOf(b) ||
    (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0) ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}

/** The live credentials bound to `accountId`, in their order. */
export function boundCredentials(
  items: readonly VaultItem[],
  accountId: string,
): CredentialItem[] {
  return items
    .filter(
      (item): item is CredentialItem =>
        isCredential(item) &&
        item.accountId === accountId &&
        item.deletedAt === null,
    )
    .sort(byPlace);
}

const resolved = new WeakMap<readonly VaultItem[], VaultItem[]>();

/**
 * `items` with each account's `methods` filled from the credentials bound to
 * it. The credentials stay in the list: they are entries. A credential whose
 * account is gone, in the trash or purged, is simply unbound as far as a reader
 * is concerned; nothing is rewritten to say so.
 */
export function resolveAccounts(items: readonly VaultItem[]): VaultItem[] {
  const cached = resolved.get(items);
  if (cached !== undefined) return cached;
  const byAccount = new Map<string, CredentialItem[]>();
  for (const item of items) {
    if (!isCredential(item) || item.accountId === null) continue;
    if (item.deletedAt !== null) continue;
    byAccount.set(item.accountId, [
      ...(byAccount.get(item.accountId) ?? []),
      item,
    ]);
  }
  const next = items.map((item): VaultItem => {
    if (!isAccount(item)) return item;
    const bound = byAccount.get(item.id)?.sort(byPlace);
    if (bound === undefined) return item;
    return { ...item, methods: bound.map((credential) => credential.method) };
  });
  resolved.set(items, next);
  return next;
}

/** Live credentials that open nothing: unbound, or bound to an account that is gone. */
export function unboundCredentials(
  items: readonly VaultItem[],
): CredentialItem[] {
  const live = new Set(
    items
      .filter((item) => isAccount(item) && item.deletedAt === null)
      .map((item) => item.id),
  );
  return items.filter(
    (item): item is CredentialItem =>
      isCredential(item) && item.deletedAt === null && !isBound(item, live),
  );
}

/**
 * `items` without the credentials that live inside an account's own file: a
 * credential bound to an account in the same list is part of that account's
 * sealed-store entry, backup listing and export, not a file of its own. A
 * credential kept on its own stays.
 */
export function outsideAccounts(items: readonly VaultItem[]): VaultItem[] {
  const accounts = new Set(
    items.filter((item) => item.kind === "account").map((item) => item.id),
  );
  return items.filter(
    (item) =>
      item.kind !== "credential" ||
      item.accountId === null ||
      !accounts.has(item.accountId),
  );
}

/**
 * What a vault listing draws. A credential bound to an account that is in the
 * same place — both live, or both in the trash — is that account's method, not
 * a second row named "Account · Password". One kept on its own stays. One
 * removed from a live account stays in the trash, so it can be restored.
 * The sealed body still holds the credential (`outsideAccounts` is the export
 * rule; this is only the list).
 */
export function listedItems(items: readonly VaultItem[]): VaultItem[] {
  const accounts = new Map<string, boolean>();
  for (const item of items) {
    if (item.kind === "account") accounts.set(item.id, item.deletedAt !== null);
  }
  return items.filter((item) => {
    if (item.kind !== "credential" || item.accountId === null) return true;
    const accountTrashed = accounts.get(item.accountId);
    if (accountTrashed === undefined) return true;
    return accountTrashed !== (item.deletedAt !== null);
  });
}
