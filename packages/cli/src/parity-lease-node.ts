/** Owner-only SQLite stores authority metadata, never credentials or responses. */
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  type LeaseRecord,
  type LeaseStorePort,
  type ResourceVersion,
  claimLease,
} from "@opensesame/app-core/lib/password-agent/lease.js";
import type { Binding } from "@opensesame/app-core/lib/password-agent/request.js";
import { z } from "zod";
const leaseSchema = z.object({
  capability: z.literal("request"),
  method: z.literal("GET"),
  reference: z.string(),
  destination: z.string(),
  destinationFingerprint: z.string(),
  header: z.enum(["Authorization", "X-API-Key"]),
  prefix: z.string(),
  id: z.string(),
  principal: z.string(),
  itemId: z.string(),
  itemVersion: z.number().int(),
  createdAt: z.number().int(),
  expiresAt: z.number().int(),
  useBudget: z.number().int(),
  usesRemaining: z.number().int(),
  revoked: z.boolean(),
});
const rowSchema = z.object({ value: z.string() });
export interface NodeLeaseStore extends LeaseStorePort {
  list(): Promise<LeaseRecord[]>;
  close(): void;
}
async function openStore(): Promise<NodeLeaseStore> {
  const { DatabaseSync } = await import("node:sqlite");
  const directory = join(
    process.env.OPENSESAME_STATE_DIR ??
      join(
        process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"),
        "opensesame",
      ),
    "password-agent",
  );
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const path = join(directory, "leases.sqlite");
  const db = new DatabaseSync(path);
  chmodSync(path, 0o600);
  db.exec(
    "PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS authority(key TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS leases(id TEXT PRIMARY KEY,value TEXT NOT NULL);",
  );
  db.prepare(
    "INSERT OR IGNORE INTO authority(key,value) VALUES('principal',?)",
  ).run(randomUUID());
  return databaseStore(db);
}
function databaseStore(db: DatabaseSync): NodeLeaseStore {
  const principal = () =>
    rowSchema.parse(
      db.prepare("SELECT value FROM authority WHERE key='principal'").get(),
    ).value;
  const unsafeGet = (id: string) =>
    leaseSchema.parse(
      JSON.parse(
        rowSchema.parse(
          db.prepare("SELECT value FROM leases WHERE id=?").get(id),
        ).value,
      ),
    );
  const get = (id: string) => {
    try {
      return unsafeGet(id);
    } catch {
      throw new Error("Lease metadata unavailable (details suppressed).");
    }
  };
  const update = (record: LeaseRecord) =>
    db
      .prepare("UPDATE leases SET value=? WHERE id=?")
      .run(JSON.stringify(record), record.id);
  return {
    async principal() {
      return principal();
    },
    async get(id) {
      return get(id);
    },
    async insert(lease) {
      db.prepare("INSERT INTO leases(id,value) VALUES(?,?)").run(
        lease.id,
        JSON.stringify(lease),
      );
    },
    async list() {
      return db
        .prepare("SELECT value FROM leases ORDER BY id")
        .all()
        .map((row) =>
          leaseSchema.parse(JSON.parse(rowSchema.parse(row).value)),
        );
    },
    async claim(
      id: string,
      binding: Binding,
      resource: ResourceVersion,
      owner: string,
      now: number,
    ) {
      db.exec("BEGIN IMMEDIATE");
      try {
        const record = claimLease(get(id), binding, resource, owner, now);
        update(record);
        db.exec("COMMIT");
        return record;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    async revoke(id, owner) {
      db.exec("BEGIN IMMEDIATE");
      try {
        const record = get(id);
        if (record.principal !== owner)
          throw new Error("Lease principal mismatch");
        record.revoked = true;
        update(record);
        db.exec("COMMIT");
        return record;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    close() {
      db.close();
    },
  };
}

export async function openLeaseStore(): Promise<NodeLeaseStore> {
  try {
    return await openStore();
  } catch {
    throw new Error("Lease store unavailable (details suppressed).");
  }
}
