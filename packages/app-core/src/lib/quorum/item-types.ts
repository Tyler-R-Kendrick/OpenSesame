/**
 * The two item types a circle is kept in (`trusted-circle` for the owner,
 * `guardian-share` for a guardian), installed into the open vault from the
 * text this module embeds (ADR 0186).
 *
 * The capability declares no egress, so the marketplace road (a person-pressed
 * network fetch) is not an option: `item-types.generated.ts` carries the exact
 * JSON of `marketplace/item-types/optional/`, one copy, and a freshness test
 * holds it to the files.
 *
 * Deliberately not re-exported from `index.ts`: it reaches the vault store,
 * and the rest of this directory does not.
 */

import { itemTypeRegistry } from "@opensesame/vault-core";
import { compareVersions } from "@opensesame/vault-item-types";
import { type VaultStore, vaultStore } from "../vault/store.js";
import { QUORUM_TYPES } from "./item-types.generated.js";

/** What installing takes from the store; a test hands a narrower one. */
export type QuorumTypeHost = Pick<VaultStore, "installItemTypeDefinition">;

async function install(store: QuorumTypeHost): Promise<void> {
  for (const { id, version, text } of QUORUM_TYPES) {
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
const running = new WeakMap<QuorumTypeHost, Promise<void>>();

/**
 * Make sure the open vault knows both types. Idempotent: a type is installed
 * only when the registry lacks it or holds a lower version, so a vault that
 * has them is not rewritten. Call it before the first write of a circle record.
 * Throws if the vault refuses a definition (another publisher took the id, a
 * title clashes) or is locked.
 */
export function ensureQuorumTypes(
  store: QuorumTypeHost = vaultStore,
): Promise<void> {
  const current = running.get(store);
  if (current) return current;
  const run = install(store).finally(() => running.delete(store));
  running.set(store, run);
  return run;
}
