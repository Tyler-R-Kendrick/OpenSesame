import {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";

const here = dirname(fileURLToPath(import.meta.url));
export const migrationsFolder = join(here, "..", "drizzle");

/** A copy of the migration folder whose journal stops before 0029. */
function foldersBefore0029(): string {
  const dir = mkdtempSync(join(tmpdir(), "os-migrate-0028-"));
  cpSync(migrationsFolder, dir, { recursive: true });
  const journalPath = join(dir, "meta", "_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8"));
  journal.entries = journal.entries.filter(
    (entry: { idx: number }) => entry.idx < 29,
  );
  writeFileSync(journalPath, JSON.stringify(journal));
  return dir;
}

/** A database migrated through 0028: rows seeded now predate `sector_key`. */
export async function databaseBefore0029() {
  const client = new PGlite();
  await client.waitReady;
  const db = drizzle(client);
  const before = foldersBefore0029();
  try {
    await migrate(db, { migrationsFolder: before });
  } finally {
    rmSync(before, { recursive: true, force: true });
  }
  return { client, db };
}

/** Apply every remaining migration (0029 onward). */
export async function migrateRest(db: ReturnType<typeof drizzle>) {
  await migrate(db, { migrationsFolder });
}

export type SectorRow = {
  id: string;
  sector_identifier: string;
  sector_key: string;
  sector_key_blocked: string | null;
};
