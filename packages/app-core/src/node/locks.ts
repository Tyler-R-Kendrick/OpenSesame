/** Kernel-backed cross-process mutexes. SQLite releases ownership on process death. */
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as pause } from "node:timers/promises";
import { z } from "zod";
import type { LockManagerLike } from "../ports.js";
type Granted<T> = (lock: Lock | null) => T | PromiseLike<T>;
const busyError = z.object({ errcode: z.literal(5) });
const MAX_WAIT_MS = 30000;
async function commitTransaction(db: DatabaseSync): Promise<void> {
  const started = Date.now();
  for (;;) {
    try {
      db.exec("COMMIT");
      return;
    } catch (error) {
      if (!busyError.safeParse(error).success) throw error;
      if (Date.now() - started >= MAX_WAIT_MS)
        throw new Error("Host lock commit timed out.");
      // Keep the transaction held; the authority callback must never replay.
      await pause(10);
    }
  }
}
class NodeLocks implements LockManagerLike {
  constructor(private readonly directory: string) {}
  request<T>(name: string, run: Granted<T>): Promise<T>;
  request<T>(name: string, options: LockOptions, run: Granted<T>): Promise<T>;
  async request<T>(
    name: string,
    ...args: [Granted<T>] | [LockOptions, Granted<T>]
  ): Promise<T> {
    const options = args.length === 1 ? {} : args[0];
    const run = args.length === 1 ? args[0] : args[1];
    if (!name || name.length > 256 || options.steal)
      throw new Error("Unsupported host lock request.");
    const db = this.open(name);
    let held = false;
    try {
      const started = Date.now();
      while (!held) {
        options.signal?.throwIfAborted();
        try {
          db.exec("PRAGMA busy_timeout=0; PRAGMA synchronous=FULL");
          db.exec("BEGIN IMMEDIATE");
          held = true;
        } catch (error) {
          if (!busyError.safeParse(error).success) throw error;
          if (options.ifAvailable) return await run(null);
          if (Date.now() - started >= MAX_WAIT_MS)
            throw new Error("Host lock acquisition timed out.");
          await pause(10, undefined, { signal: options.signal });
        }
      }
      db.exec(
        "CREATE TABLE IF NOT EXISTS mutex_marker (id INTEGER PRIMARY KEY)",
      );
      const result = await run({ name, mode: options.mode ?? "exclusive" });
      await commitTransaction(db);
      held = false;
      return result;
    } finally {
      try {
        if (held) db.exec("ROLLBACK");
      } finally {
        db.close();
      }
    }
  }
  private open(name: string): DatabaseSync {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const path = join(
      this.directory,
      `${createHash("sha256").update(name).digest("hex")}.sqlite`,
    );
    const db = new DatabaseSync(path);
    try {
      chmodSync(path, 0o600);
      return db;
    } catch (error) {
      db.close();
      throw error;
    }
  }
}
export function createNodeLocks(directory: string): LockManagerLike {
  return new NodeLocks(directory);
}
