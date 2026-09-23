/**
 * Migration 0029: `oauth_clients.sector_key` backfill and the fail-safe for
 * legacy rows whose spellings of one sector belonged to different owners.
 *
 * Applies every migration up to 0028, seeds rows exactly as the registration
 * API stored them before canonicalization, then applies 0029 alone.
 */
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
import { overlapCast } from "@opensesame/os-domain";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sectorKeyOf } from "../src/client-sector-claims.js";
import { type Database, PostgresRepositories } from "../src/repos/postgres.js";
import { makePrincipal } from "./factories.js";

const here = dirname(fileURLToPath(import.meta.url));
const migrationsFolder = join(here, "..", "drizzle");

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

type Row = {
  id: string;
  sector_identifier: string;
  sector_key: string;
  sector_key_blocked: string | null;
};

/** Spellings the backfill must key exactly as the issuer does. */
const EXACT = [
  "https://rp.example",
  "https://UPPER.EXAMPLE",
  "HTTPS://Up.example:443/",
  "https://port.example:0443",
  "http://plain.example:80/a",
  "https://empty-port.example:/a/b/",
  "https://case.example/A/b",
  "https://quote.example/a'b",
  "https://127.0.0.1:8788",
  "https://under_score.example",
  "https://dot.example.",
  "  https://pad.example  ",
  "https://alt.example:8443/p/",
  "sector_123",
  "localhost:3000",
];

/** Spellings it cannot prove it derives exactly; refused, never guessed. */
const UNPARSED = [
  "https://dots.example/a/../b",
  "https://pct.example/%7Efoo",
  "https://0x7f.1",
  "https://127.1",
  "https://xn--nxasmq6b.example",
  "https:noslash.example",
  "https://big-port.example:99999",
  "https://user@creds.example",
  "https://space.example/a b",
];

describe("drizzle 0029 sector_key backfill", () => {
  let client: PGlite;
  let rows: Map<string, Row>;
  let claims: Map<string, string>;
  const owner = {
    a: makePrincipal(),
    b: makePrincipal(),
    e: makePrincipal(),
    f: makePrincipal(),
  };
  let at = Date.parse("2026-01-01T00:00:00Z");

  async function seed(
    id: string,
    sector: string,
    ownerId: string | null,
    state = "active",
  ) {
    at += 1_000;
    await client.query(
      `insert into oauth_clients (id, owner_principal_id, admission_mode,
         display_name, sector_identifier, token_endpoint_auth_method, state,
         created_at)
       values ($1, $2, 'pre_registered', 'RP', $3, 'none', $4, $5)`,
      [id, ownerId, sector, state, new Date(at).toISOString()],
    );
  }

  beforeAll(async () => {
    client = new PGlite();
    await client.waitReady;
    const db = drizzle(client);
    const before = foldersBefore0029();
    try {
      await migrate(db, { migrationsFolder: before });
    } finally {
      rmSync(before, { recursive: true, force: true });
    }
    const database: Database = overlapCast(db);
    const repos = new PostgresRepositories(database);
    for (const principal of Object.values(owner)) {
      await repos.principals.create(principal);
    }
    // Owner A registered first; owner B later registered two other spellings
    // of the same sector — one live, one already revoked.
    await seed("a1", "https://shared.example", owner.a.id);
    await seed("b1", "https://SHARED.example:443/", owner.b.id);
    await seed("b2", "https://shared.example/", owner.b.id, "revoked");
    await seed("a2", "https://Shared.example", owner.a.id);
    // E's only client on this sector is revoked; F's later live one keeps it.
    await seed("e1", "https://held.example", owner.e.id, "revoked");
    await seed("f1", "https://HELD.example/", owner.f.id);
    for (const [i, sector] of EXACT.entries())
      await seed(`x${i}`, sector, null);
    for (const [i, sector] of UNPARSED.entries()) {
      await seed(`u${i}`, sector, null);
    }

    await migrate(db, { migrationsFolder });
    const result = await client.query<Row>(
      "select id, sector_identifier, sector_key, sector_key_blocked from oauth_clients",
    );
    rows = new Map(result.rows.map((row) => [row.id, row]));
    const held = await client.query<{ sector_key: string; owner_key: string }>(
      "select sector_key, owner_key from oauth_client_sector_claims",
    );
    claims = new Map(held.rows.map((r) => [r.sector_key, r.owner_key]));
  }, 60_000);

  afterAll(async () => {
    await client.close();
  });

  const row = (id: string): Row => {
    const found = rows.get(id);
    if (!found) throw new Error(`missing row ${id}`);
    return found;
  };

  it("keys every provable spelling exactly as the issuer derives it", () => {
    for (const [i, sector] of EXACT.entries()) {
      const { sector_key, sector_key_blocked } = row(`x${i}`);
      expect(sector_key, sector).toBe(sectorKeyOf(sector));
      expect(sector_key_blocked, sector).toBeNull();
    }
  });

  it("refuses spellings it cannot prove, under a key no real one can equal", () => {
    for (const [i, sector] of UNPARSED.entries()) {
      const { sector_key, sector_key_blocked } = row(`u${i}`);
      expect(sector_key_blocked, sector).toBe("unparsed_legacy_spelling");
      expect(sector_key.startsWith("unparsed:"), sector).toBe(true);
      expect(claims.has(sector_key), sector).toBe(false);
    }
  });

  it("gives a shared key to its first owner and blocks every other owner's row", () => {
    expect(row("a1").sector_key).toBe("shared.example");
    expect(row("b1").sector_key).toBe("shared.example");
    expect(claims.get("shared.example")).toBe(owner.a.id);
    expect(row("a1").sector_key_blocked).toBeNull();
    expect(row("a2").sector_key_blocked).toBeNull();
    expect(row("b1").sector_key_blocked).toBe("cross_owner_collision");
    expect(row("b2").sector_key_blocked).toBe("cross_owner_collision");
  });

  it("prefers a live holder over an earlier, revoked one", () => {
    expect(claims.get("held.example")).toBe(owner.f.id);
    expect(row("f1").sector_key_blocked).toBeNull();
    expect(row("e1").sector_key_blocked).toBe("cross_owner_collision");
  });

  it("holds every unblocked key for exactly one owner", () => {
    for (const { sector_key, sector_key_blocked, id } of rows.values()) {
      if (sector_key_blocked) continue;
      expect(claims.has(sector_key), id).toBe(true);
    }
  });
});
