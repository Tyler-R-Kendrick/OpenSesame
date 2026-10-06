/**
 * Run work against an encrypted database and let go of it, the way the
 * device-sealed stores do: a connection left open would block "Reset this
 * browser" from deleting the database.
 */

import { storageWritesHalted } from "../storage-halt.js";
import { type EncryptedDb, openEncryptedDb } from "./db.js";
import { DEVICE_EDB_NAMESPACE } from "./names.js";
import type { Schema } from "./schema.js";

/**
 * The result of `run`, or undefined when the database cannot be had (no
 * durable key, no IndexedDB, a reset under way) or the work failed. The
 * caller keeps what it could not store in memory, for this document only -
 * never in the clear.
 */
export async function withEncryptedDb<T>(
  logicalName: string,
  schema: Schema,
  run: (db: EncryptedDb) => Promise<T>,
  customerNamespace = DEVICE_EDB_NAMESPACE,
): Promise<T | undefined> {
  // Opening alone recreates a deleted database.
  if (storageWritesHalted()) return undefined;
  let db: EncryptedDb;
  try {
    db = await openEncryptedDb(logicalName, schema, customerNamespace);
  } catch {
    return undefined;
  }
  try {
    return await run(db);
  } catch {
    return undefined;
  } finally {
    db.close();
  }
}
