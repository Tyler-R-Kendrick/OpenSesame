/**
 * Retired-password digests in an encrypted database (ADR 0175): the vault's
 * name and the item's id - the scope - are inside the seal, found by a blind
 * index entry that exists only once a password has been checked. Digests
 * are deliberately not indexed: a shared entry would show a password reused
 * across two items to anyone holding the disk.
 */

import { isString } from "@opensesame/os-domain";
import type { PasswordDigestStore } from "../vault/password-history-types.js";
import type { WriteGuard } from "./db.js";
import { DEVICE_EDB_NAMESPACE } from "./names.js";
import { defineSchema } from "./schema.js";
import { withEncryptedDb } from "./with-db.js";

export const PASSWORD_DATABASE = "password-history";

export const passwordSchema = defineSchema({
  digests: { key: "id", columns: { scope: { eq: true } } },
});

/** `ready` resolves when rows may be read: after a legacy migration has run. */
export function createPasswordDigestStore(
  ready: () => Promise<void> = async () => {},
  guard?: WriteGuard,
): PasswordDigestStore {
  const run = async <T>(work: Parameters<typeof withEncryptedDb<T>>[2]) => {
    await ready();
    return withEncryptedDb(
      PASSWORD_DATABASE,
      passwordSchema,
      work,
      DEVICE_EDB_NAMESPACE,
    );
  };
  return {
    add: (scope, digest) =>
      run(async (db) => {
        // Keyed by both, so a digest moved twice (two tabs switching the
        // capability on at once) is one row.
        const id = `${scope}\u0000${digest}`;
        if (guard) await db.putGuarded("digests", { id, scope, digest }, guard);
        else await db.put("digests", { id, scope, digest });
        return true as const;
      }),
    digestsFor: (scope) =>
      run(async (db) => {
        const rows = await db.find("digests", { scope });
        return rows.flatMap((row) =>
          isString(row.digest) ? [row.digest] : [],
        );
      }),
    forget: (scope) =>
      run(async (db) => {
        const rows = await db.find("digests", { scope });
        for (const row of rows) {
          if (isString(row.id)) await db.delete("digests", row.id);
        }
        return rows.length;
      }),
  };
}
