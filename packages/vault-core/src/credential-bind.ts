/**
 * Binding a credential to an account, releasing it, and saving one written on
 * its own (ADR 0179).
 */

import type { AccountItem } from "./account.js";
import { credentialOf } from "./credential-split.js";
import {
  type CredentialItem,
  boundCredentialName,
  boundCredentials,
  isAccount,
  isCredential,
} from "./credential.js";
import type { VaultItem } from "./model.js";

export type BindRefusal =
  | "missing-credential"
  | "missing-account"
  | "trashed"
  | "legacy-seal"
  | "invalid-identity";

export type BindOutcome =
  | { readonly ok: true; readonly items: VaultItem[] }
  | { readonly ok: false; readonly refusal: BindRefusal };

/** Why a credential may not be bound to `accountId`, or null when it may. */
export function bindRefusal(
  items: readonly VaultItem[],
  credentialId: string,
  accountId: string,
): BindRefusal | null {
  if (
    identityConflict(items, credentialId, "credential") ||
    identityConflict(items, accountId, "account")
  )
    return "invalid-identity";
  const credential = items.find(
    (item): item is CredentialItem =>
      isCredential(item) && item.id === credentialId,
  );
  if (credential === undefined) return "missing-credential";
  if (credential.method.id !== credential.id) return "invalid-identity";
  if (credential.deletedAt !== null) return "trashed";
  const account = items.find(
    (item): item is AccountItem => isAccount(item) && item.id === accountId,
  );
  if (account === undefined || account.deletedAt !== null) {
    return "missing-account";
  }
  // A password an earlier pepper sealed was sealed to the account it was on
  // (ADR 0172); bound to another it could not be opened again.
  if (credential.method.type === "password" && credential.method.sealed) {
    return "legacy-seal";
  }
  return null;
}

/** Bind an existing credential to an account: it becomes one of its login methods. */
export function bindCredential(
  items: readonly VaultItem[],
  credentialId: string,
  accountId: string,
  now: string,
): BindOutcome {
  const refusal = bindRefusal(items, credentialId, accountId);
  if (refusal !== null) return { ok: false, refusal };
  const account = items.find(
    (item): item is AccountItem => isAccount(item) && item.id === accountId,
  );
  const credential = items.find(
    (item): item is CredentialItem =>
      isCredential(item) && item.id === credentialId,
  );
  if (account === undefined || credential === undefined) {
    return { ok: false, refusal: "missing-account" };
  }
  const siblings = boundCredentials(items, accountId).filter(
    (other) => other.id !== credentialId,
  );
  const methods = [...siblings.map((other) => other.method), credential.method];
  const bound: CredentialItem = {
    ...credential,
    accountId,
    order: siblings.length,
    name: boundCredentialName(account.name, credential.method, methods),
    folderId: account.folderId,
    updatedAt: now,
  };
  return {
    ok: true,
    items: items.map((item) => (item.id === credentialId ? bound : item)),
  };
}

/** Release a credential from its account. It keeps its name, its folder and every value. */
export function unbindCredential(
  items: readonly VaultItem[],
  credentialId: string,
  now: string,
): VaultItem[] {
  if (identityConflict(items, credentialId, "credential"))
    throw new Error(
      "Credential identity is ambiguous or belongs to another item.",
    );
  return items.map((item) =>
    isCredential(item) && item.id === credentialId && item.accountId !== null
      ? { ...item, accountId: null, order: undefined, updatedAt: now }
      : item,
  );
}

export type SaveOutcome =
  | { readonly ok: true; readonly items: VaultItem[] }
  | { readonly ok: false; readonly refusal: BindRefusal };

/**
 * Save a credential written on its own, bound or not. Binding it to an account
 * (or moving it to another) makes it that account's last login method, named
 * and filed with the account; releasing it keeps its name and folder. It may
 * not go to an account that is not there, and a password an earlier pepper
 * sealed may not change accounts (`bindRefusal`).
 */
export function saveCredential(
  items: readonly VaultItem[],
  credential: CredentialItem,
  now: string,
): SaveOutcome {
  if (saveIdentityConflict(items, credential))
    return { ok: false, refusal: "invalid-identity" };
  const prior = credentialOf(items, credential.id);
  const accountId = credential.accountId;
  if (accountId === null) {
    return {
      ok: true,
      items: replaceInPlace(
        items,
        { ...credential, order: undefined, named: undefined },
        now,
      ),
    };
  }
  const account = items.find(
    (item): item is AccountItem => isAccount(item) && item.id === accountId,
  );
  if (account === undefined || account.deletedAt !== null) {
    return { ok: false, refusal: "missing-account" };
  }
  const moving = prior?.accountId !== accountId;
  if (
    moving &&
    credential.method.type === "password" &&
    credential.method.sealed
  ) {
    return { ok: false, refusal: "legacy-seal" };
  }
  const siblings = boundCredentials(items, accountId).filter(
    (other) => other.id !== credential.id,
  );
  const methods = [...siblings.map((other) => other.method), credential.method];
  const named = namedByPerson(credential, prior);
  const placed: CredentialItem = {
    ...credential,
    order: moving ? siblings.length : (prior?.order ?? siblings.length),
    name: named
      ? credential.name
      : boundCredentialName(account.name, credential.method, methods),
    named: named ? true : undefined,
    folderId: account.folderId,
    updatedAt: now,
  };
  return { ok: true, items: replaceInPlace(items, placed, now) };
}

const GENERATED_NAME =
  /^(Password|API key|Token|OAuth client|Authenticator) [0-9a-f]{8}$/u;

/**
 * Whether the name on a credential being saved is the person's: one they
 * changed, one an earlier save already marked theirs, or a new one that is not
 * the shape a draft generates.
 */
function namedByPerson(
  credential: CredentialItem,
  prior: CredentialItem | undefined,
): boolean {
  if (prior === undefined) {
    return (
      credential.named === true ||
      (credential.name.trim() !== "" && !GENERATED_NAME.test(credential.name))
    );
  }
  return prior.named === true || credential.name !== prior.name;
}

function saveIdentityConflict(
  items: readonly VaultItem[],
  credential: CredentialItem,
): boolean {
  return (
    credential.method.id !== credential.id ||
    identityConflict(items, credential.id, "credential") ||
    (credential.accountId !== null &&
      identityConflict(items, credential.accountId, "account"))
  );
}

function identityConflict(
  items: readonly VaultItem[],
  id: string,
  kind: VaultItem["kind"],
): boolean {
  const matching = items.filter((item) => item.id === id);
  return (
    matching.length > 1 ||
    matching.some(
      (item) =>
        item.kind !== kind ||
        (isCredential(item) && item.method.id !== item.id),
    )
  );
}

function replaceInPlace(
  items: readonly VaultItem[],
  next: CredentialItem,
  now: string,
): VaultItem[] {
  const at = items.findIndex((item) => item.id === next.id);
  const stamped = { ...next, updatedAt: now };
  return at >= 0
    ? items.map((item, index) => (index === at ? stamped : item))
    : [...items, stamped];
}

/** What to tell a person who asked for a binding that cannot be made. */
export function bindRefusalMessage(refusal: BindRefusal): string {
  switch (refusal) {
    case "invalid-identity":
      return "Credential identity is ambiguous or belongs to another item.";
    case "missing-credential":
      return "That credential is no longer there.";
    case "missing-account":
      return "That account is no longer there.";
    case "trashed":
      return "That credential is in the trash.";
    case "legacy-seal":
      return "Convert this password in its account first: an earlier pepper sealed it to the account it is on.";
  }
}
