import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Integrity of the drizzle migration folder.
 *
 * `drizzle-kit generate` diffs the schema against the **latest** snapshot in
 * `meta/` to decide what a new migration should contain. So a migration that
 * lands without its snapshot is not a cosmetic gap: the next `generate` falls
 * back to the previous snapshot, sees the missing migration's tables as absent,
 * and re-emits them as a fresh migration. That migration then `CREATE TABLE`s
 * objects the earlier one already created, and fails against any database that
 * has run it.
 *
 * That is not hypothetical — `0022_agent_auth` shipped without
 * `meta/0022_snapshot.json`, and every `db:generate` afterwards re-emitted the
 * four `agent_*` tables as a phantom `0023`.
 *
 * The suites that call `createPgTestContext` apply every migration to a real
 * Postgres, so they would catch the phantom migration once it was committed.
 * Nothing caught the missing snapshot that causes it, which is what this test
 * is for.
 */

const here = dirname(fileURLToPath(import.meta.url));
const drizzleDir = join(here, "..", "drizzle");
const metaDir = join(drizzleDir, "meta");

type JournalEntry = {
  readonly idx: number;
  readonly tag: string;
};

function readJournal(): readonly JournalEntry[] {
  const raw = readFileSync(join(metaDir, "_journal.json"), "utf8");
  const parsed: unknown = JSON.parse(raw);
  const entries = (parsed as { entries?: readonly JournalEntry[] }).entries;
  if (!entries || entries.length === 0) {
    throw new Error("migration journal has no entries");
  }
  return entries;
}

function snapshotPath(idx: number): string {
  return join(metaDir, `${String(idx).padStart(4, "0")}_snapshot.json`);
}

/**
 * Snapshots that were never committed alongside their migration and cannot now
 * be reconstructed without fabricating historical schema state.
 *
 * These are harmless where they sit: `generate` only reads the newest snapshot,
 * and `migrate` replays the `.sql` files and never reads snapshots at all. They
 * are listed rather than backfilled precisely because inventing the state they
 * would have recorded is worse than admitting the gap. Do not add to this list
 * to silence a failure — a *new* gap is the bug this test exists to catch, and
 * the fix is to commit the snapshot, not to allow it.
 */
const HISTORICAL_GAPS: readonly number[] = [7, 9];

describe("drizzle migration journal", () => {
  it("has a .sql file for every journal entry", () => {
    const missing = readJournal()
      .filter((entry) => !existsSync(join(drizzleDir, `${entry.tag}.sql`)))
      .map((entry) => entry.tag);
    expect(missing).toEqual([]);
  });

  it("has a snapshot for every journal entry except the known historical gaps", () => {
    const missing = readJournal()
      .filter((entry) => !HISTORICAL_GAPS.includes(entry.idx))
      .filter((entry) => !existsSync(snapshotPath(entry.idx)))
      .map((entry) => `${entry.idx}: ${entry.tag}`);
    expect(missing).toEqual([]);
  });

  it("has a snapshot for the newest entry, which is what generate diffs against", () => {
    const entries = readJournal();
    const newest = entries.reduce((a, b) => (b.idx > a.idx ? b : a));
    expect(HISTORICAL_GAPS).not.toContain(newest.idx);
    expect(existsSync(snapshotPath(newest.idx))).toBe(true);
  });

  it("keeps every allowed gap genuinely historical, never the newest entry", () => {
    // A gap is only harmless behind a later snapshot. If the list ever grows to
    // include the newest migration, the allowlist has been used to hide the bug.
    const newestIdx = readJournal().reduce(
      (max, entry) => Math.max(max, entry.idx),
      -1,
    );
    for (const gap of HISTORICAL_GAPS) {
      expect(gap).toBeLessThan(newestIdx);
    }
  });

  it("chains each snapshot to the one before it", () => {
    const entries = readJournal();
    const present = entries.filter((entry) =>
      existsSync(snapshotPath(entry.idx)),
    );

    let previousId: string | null = null;
    for (const entry of present) {
      const snapshot: unknown = JSON.parse(
        readFileSync(snapshotPath(entry.idx), "utf8"),
      );
      const { id, prevId } = snapshot as {
        id?: string;
        prevId?: string;
      };
      expect(id, `${entry.tag} snapshot has no id`).toBeTruthy();

      // Only assert linkage across an unbroken run. Across one of the gaps
      // above the chain legitimately skips a link, because the snapshot that
      // would have carried it was never written.
      const contiguous =
        previousId !== null &&
        !HISTORICAL_GAPS.includes(entry.idx - 1) &&
        present.some((e) => e.idx === entry.idx - 1);
      if (contiguous) {
        expect(prevId, `${entry.tag} snapshot is not chained`).toBe(previousId);
      }
      previousId = id ?? null;
    }
  });
});
