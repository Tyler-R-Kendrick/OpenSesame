/**
 * The item type a reset mailbox is kept in (`email-account`), installed into
 * the open vault from the text this module embeds.
 *
 * The capability declares no egress for item types, so the marketplace road (a
 * person-pressed network fetch) is not an option: `mail-type.generated.ts`
 * carries the exact JSON of `marketplace/item-types/optional/email-account.json`,
 * one copy, and a freshness test holds it to the file. A vault that already has
 * the type, from the marketplace or from this module, is not rewritten.
 *
 * Deliberately not re-exported from `password-reset-mail.ts`: it reaches the
 * vault store, and that file is read by the item editor.
 */

import { itemTypeRegistry } from "@opensesame/vault-core";
import { compareVersions } from "@opensesame/vault-item-types";
import { type VaultStore, vaultStore } from "../vault/store.js";
import { RESET_MAIL_TYPES } from "./mail-type.generated.js";

/** What installing takes from the store; a test hands a narrower one. */
export type ResetMailTypeHost = Pick<VaultStore, "installItemTypeDefinition">;

async function install(store: ResetMailTypeHost): Promise<void> {
  for (const { id, version, text } of RESET_MAIL_TYPES) {
    const have = itemTypeRegistry().get(id);
    // Same or newer already here: installing again would only reseal the body.
    if (have && compareVersions(have.metadata.version, version) >= 0) continue;
    const result = await store.installItemTypeDefinition(text);
    if (!result.ok) {
      throw new Error(
        `The ${id} item type could not be installed: ${result.message}`,
      );
    }
  }
}

/** Calls made while an install is under way wait for it instead of starting another. */
const running = new WeakMap<ResetMailTypeHost, Promise<void>>();

/**
 * Make sure the open vault knows the mailbox type. Idempotent: it is installed
 * only when the registry lacks it or holds a lower version. Call it before the
 * first write of a mailbox. Throws if the vault refuses the definition (another
 * publisher took the id, a title clashes) or is locked.
 */
export function ensureResetMailType(
  store: ResetMailTypeHost = vaultStore,
): Promise<void> {
  const current = running.get(store);
  if (current) return current;
  const run = install(store).finally(() => running.delete(store));
  running.set(store, run);
  return run;
}
