/**
 * What the account editor does to a password method (ADR 0173, ADR 0174).
 *
 * A method keeps one secret, in the clear in the sealed body: the password, or
 * for an algorithmic one the root the password is computed from. A pepper is
 * never held here: *Include pepper* only says that the password has a slot, and
 * where (`pepperAt`); the pepper itself is the person's, not asked for and not
 * stored.
 */

import {
  disablePack,
  enablePack,
} from "@opensesame/app-core/lib/type-packs/installer.js";
import { countPackItems } from "@opensesame/app-core/lib/type-packs/watch.js";
import {
  defaultGenerator,
  newSecretFor,
} from "@opensesame/app-core/lib/vault/generators/index.js";
import type { OfferedGeneratorId } from "@opensesame/app-core/lib/vault/generators/index.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import {
  type AccountItem,
  type CredentialItem,
  type Folder,
  type LoginMethod,
  type PasswordMethod,
  type VaultItem,
  completePassword,
  isCredential,
  isPepperPosition,
  producePassword,
  unboundCredentials,
} from "@opensesame/vault-core";

/** The password the editor shows: what the facade produces before any pepper. */
export function shownPassword(method: PasswordMethod): string {
  const produced = producePassword(method);
  if (produced.status === "ok") return produced.password;
  return produced.status === "slotted"
    ? `${produced.head}${produced.tail}`
    : "";
}

/** A typed value: it replaces what the method kept, and makes the method a typed one. */
export function holdValue(
  method: PasswordMethod,
  value: string,
): PasswordMethod {
  const { sealed: _sealed, ...rest } = method;
  return { ...rest, generator: { id: "manual" }, secret: value };
}

/**
 * A different generator: a new secret for it, which is the root for an
 * algorithmic one. A typed password stays what it was.
 */
export function switchGenerator(
  method: PasswordMethod,
  id: OfferedGeneratorId,
): PasswordMethod {
  const { sealed: _sealed, ...rest } = method;
  const generator = defaultGenerator(id);
  const kept =
    id === "manual" ? shownPassword(method) : newSecretFor(generator);
  return { ...rest, generator, secret: kept };
}

/**
 * A fresh value from the method's own random generator. Null when there is
 * nothing to make: the rules choose no class (the options are the problem, not
 * a message), or the generator is algorithmic, which is rotated instead.
 */
export function regenerate(method: PasswordMethod): PasswordMethod | null {
  const { generator } = method;
  if (generator.id !== "rules" && generator.id !== "passphrase") return null;
  try {
    return { ...method, secret: newSecretFor(generator) };
  } catch {
    return null;
  }
}

/** An algorithmic password's next one: the counter moves, the root stays. */
export function rotate(method: PasswordMethod): PasswordMethod | null {
  const { generator } = method;
  if (generator.id !== "derived") return null;
  return {
    ...method,
    generator: { ...generator, counter: generator.counter + 1 },
  };
}

/** *Include pepper* on or off. Turning it off forgets where it went; nothing else changes. */
export function setPepper(method: PasswordMethod, on: boolean): PasswordMethod {
  const { pepperAt: _at, ...rest } = method;
  return on ? { ...method, pepper: true } : { ...rest, pepper: false };
}

/** Where the pepper goes. Text that is not a position is not kept; empty means last. */
export function setPepperAt(
  method: PasswordMethod,
  text: string,
): PasswordMethod | null {
  if (!isPepperPosition(text)) return null;
  const { pepperAt: _at, ...rest } = method;
  return text.trim() === "" ? rest : { ...rest, pepperAt: text.trim() };
}

/** The password a method produces whole, or what it leaves of it, as text to compare. */
function producedKey(method: PasswordMethod): string {
  const produced = producePassword(method);
  return `${produced.status}\u0000${completePassword(produced) ?? shownPassword(method)}`;
}

/**
 * Methods as they are saved: `changedAt` moves when a password did, whether it
 * was typed, made again or computed under a new counter.
 */
export function settleMethods(
  methods: readonly LoginMethod[],
  saved: readonly LoginMethod[],
): LoginMethod[] {
  const now = new Date().toISOString();
  return methods.map((method): LoginMethod => {
    if (method.type !== "password") return method;
    const before = saved.find(
      (candidate): candidate is PasswordMethod =>
        candidate.type === "password" && candidate.id === method.id,
    );
    const changed =
      before === undefined || producedKey(before) !== producedKey(method);
    return changed ? { ...method, changedAt: now } : method;
  });
}

/** The account as it is saved (`settleMethods`). */
export function settleForSave(
  account: AccountItem,
  existing: AccountItem | undefined,
): AccountItem {
  return {
    ...account,
    methods: settleMethods(account.methods, existing?.methods ?? []),
  };
}

/**
 * An account as the editor holds it, split into what is written as the account
 * and the credentials it takes from those the vault keeps on its own (or on
 * another account): a method whose id is such a credential's was chosen from the
 * `+`, not made, and is bound to this account in the same write, never copied
 * (ADR 0179).
 */
export type AdoptedSplit = {
  readonly account: AccountItem;
  readonly adopted: readonly CredentialItem[];
};

export function splitAdopted(
  items: readonly VaultItem[],
  account: AccountItem,
): AdoptedSplit {
  const adopted: CredentialItem[] = [];
  const own: LoginMethod[] = [];
  for (const method of account.methods) {
    const held = items.find(
      (item): item is CredentialItem =>
        isCredential(item) &&
        item.id === method.id &&
        item.deletedAt === null &&
        item.accountId !== account.id,
    );
    if (held === undefined) own.push(method);
    else adopted.push({ ...held, method, accountId: account.id });
  }
  return { account: { ...account, methods: own }, adopted };
}

/** The two writes of the store an item is saved with. */
export type ItemWriter = {
  saveItem: (item: VaultItem, folder?: Folder) => Promise<void>;
  saveItems: (items: readonly VaultItem[], folder?: Folder) => Promise<void>;
};

/**
 * Save an item. An account that took credentials from the `+` is saved with
 * them in one write: each is bound to it there, not copied (ADR 0179).
 */
export async function saveWithCredentials(
  writer: ItemWriter,
  items: readonly VaultItem[],
  item: VaultItem,
  folder?: Folder,
): Promise<void> {
  if (item.kind !== "account") return writer.saveItem(item, folder);
  const split = splitAdopted(items, item);
  if (split.adopted.length === 0) return writer.saveItem(item, folder);
  return writer.saveItems([split.account, ...split.adopted], folder);
}

/** The credentials kept on their own that an account may take, and has not. */
export function bindableCredentials(
  items: readonly VaultItem[],
  methods: readonly LoginMethod[],
): CredentialItem[] {
  const taken = new Set(methods.map((method) => method.id));
  return unboundCredentials(items).filter(
    (credential) =>
      credential.deletedAt === null &&
      !taken.has(credential.id) &&
      !(credential.method.type === "password" && credential.method.sealed),
  );
}

/**
 * The pack switch an editor reaches for. A seam, so a test can see which type
 * was switched on without downloading it.
 *
 * Choosing a type while an account is still a draft installs it for this
 * document and remembers nothing (`keep: false`): the type is the vault's only
 * once an account holding a credential of it is saved. A draft that is
 * abandoned gives the type back (`release`); a vault that now holds items of
 * it refuses, which is how a saved account keeps it.
 */
export const credentialPackSeams = {
  enable: (id: string) => enablePack(id, { keep: false }),
  release: async (ids: readonly string[]) => {
    const held = countPackItems(vaultStore.getSnapshot().items);
    for (const id of ids) if (!held.has(id)) await disablePack(id);
  },
};
