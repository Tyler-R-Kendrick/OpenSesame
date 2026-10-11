/**
 * Reset addresses kept before mailboxes were vault items: a list of
 * `{ id, address }` per vault under one device key. A login bound to one
 * names that id, so each address becomes an `email-account` item under the
 * same id and the binding keeps working; the list is then dropped.
 *
 * Only the address is carried over. The old list held nothing else.
 */

import {
  type JsonObject,
  type JsonValue,
  isJsonObject,
  isString,
  overlapCast,
} from "@opensesame/os-domain";
import { createTypedItem, itemTypeRegistry } from "@opensesame/vault-core";
import { activeCapabilityVaultId } from "../capability-connector-scope.js";
import { kvDelete, kvGet, kvSet } from "../kv.js";
import { mailboxOf, normalizeResetAddress } from "../password-reset-mail.js";
import { ensureResetMailType } from "./mail-type.js";
import type { MailboxVault } from "./mailbox-store.js";

export const LEGACY_RESET_EMAILS_KEY = "password-reset-mail.v1";

export type LegacyResetEmail = { id: string; address: string };

function readAll(): Record<string, LegacyResetEmail[]> {
  const raw = kvGet(LEGACY_RESET_EMAILS_KEY);
  if (!raw) return {};
  try {
    const parsed = overlapCast(JSON.parse(raw));
    if (!isJsonObject(parsed) || !isJsonObject(parsed.byVault)) return {};
    return byVault(parsed.byVault);
  } catch {
    return {};
  }
}

function byVault(value: JsonObject): Record<string, LegacyResetEmail[]> {
  const rows: Array<[string, LegacyResetEmail[]]> = [];
  for (const [vaultId, entries] of Object.entries(value)) {
    if (!Array.isArray(entries)) continue;
    const emails = entries.flatMap(emailFrom);
    if (emails.length > 0) rows.push([vaultId, emails]);
  }
  return Object.fromEntries(rows);
}

function emailFrom(value: JsonValue): LegacyResetEmail[] {
  if (!isJsonObject(value) || !isString(value.id) || !isString(value.address)) {
    return [];
  }
  const address = normalizeResetAddress(value.address);
  return address ? [{ id: value.id, address }] : [];
}

/** The addresses a vault kept under the old list. */
export function legacyResetEmails(
  vaultId = activeCapabilityVaultId(),
): readonly LegacyResetEmail[] {
  return readAll()[vaultId] ?? [];
}

function forget(vaultId: string): void {
  const all = readAll();
  delete all[vaultId];
  if (Object.keys(all).length === 0) kvDelete(LEGACY_RESET_EMAILS_KEY);
  else kvSet(LEGACY_RESET_EMAILS_KEY, JSON.stringify({ byVault: all }));
}

/**
 * Turn the open vault's old list into mailbox items and forget the list.
 * Idempotent: an id already an item, or an address already a mailbox, is not
 * made twice, and the list is dropped only once every entry is accounted for.
 * Returns how many items it made.
 */
export async function adoptLegacyResetEmails(
  store: MailboxVault,
  vaultId = activeCapabilityVaultId(),
): Promise<number> {
  const legacy = legacyResetEmails(vaultId);
  if (legacy.length === 0) return 0;
  await ensureResetMailType(store);
  const definition = itemTypeRegistry().get("email-account");
  if (!definition) throw new Error("email-account is not installed");
  let made = 0;
  for (const email of legacy) {
    const items = store.getSnapshot().items;
    const taken = items.some(
      (item) =>
        item.id === email.id || mailboxOf(item)?.address === email.address,
    );
    if (taken) continue;
    const item = createTypedItem(
      definition,
      { address: email.address },
      email.address,
    );
    await store.saveItem({ ...item, id: email.id });
    made += 1;
  }
  forget(vaultId);
  return made;
}
