/**
 * Migration 0029: `oauth_clients.sector_key` backfill and the fail-safe for
 * legacy rows whose spellings of one sector belonged to different owners.
 *
 * Applies every migration up to 0028, seeds rows exactly as the registration
 * API stored them before canonicalization, then applies 0029 alone.
 */
import type { PGlite } from "@electric-sql/pglite";
import { overlapCast } from "@opensesame/os-domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sectorKeyOf } from "../src/client-sector-claims.js";
import { type Database, PostgresRepositories } from "../src/repos/postgres.js";
import { makePrincipal } from "./factories.js";
import {
  type SectorRow as Row,
  databaseBefore0029,
  migrateRest,
} from "./migrate-0029-helpers.js";

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
  // Postgres has no `\v` escape: a trim set spelled E'...\v' strips the
  // letter `v`, which turned these into `app.de`, `rp.example/na`, ...
  "https://app.dev",
  "https://rp.example/nav",
  "https://rp.example/v",
  "https://v.example",
  "https://vv.example/v/",
  "v",
  "\thttps://tab.example\n",
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
  // Whitespace the SQL does not trim is refused, never guessed at.
  "\vhttps://vt.example",
  "https://ff.example\f",
  "\u00a0https://nbsp.example",
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
    c: makePrincipal(),
    d: makePrincipal(),
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
    const fresh = await databaseBefore0029();
    client = fresh.client;
    const db = fresh.db;
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
    // E's only client on this sector is revoked; F's later live one is still
    // a later owner, and gets nothing E's users already have.
    await seed("e1", "https://held.example", owner.e.id, "revoked");
    await seed("f1", "https://HELD.example/", owner.f.id);
    // Owners that only a `v`-eating trim would have put on one key.
    await seed("c1", "https://x.dev", owner.c.id);
    await seed("d1", "https://x.de", owner.d.id);
    for (const [i, sector] of EXACT.entries())
      await seed(`x${i}`, sector, null);
    for (const [i, sector] of UNPARSED.entries()) {
      await seed(`u${i}`, sector, null);
    }

    await migrateRest(db);
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

  it("gives a key to its earliest owner even when every client of theirs is revoked", () => {
    // A live later owner would otherwise inherit the subjects E's users have.
    expect(claims.get("held.example")).toBe(owner.e.id);
    expect(row("e1").sector_key_blocked).toBeNull();
    expect(row("f1").sector_key_blocked).toBe("cross_owner_collision");
  });

  it("never trims a sector's own letters into another owner's key", () => {
    expect(row("c1").sector_key).toBe("x.dev");
    expect(row("d1").sector_key).toBe("x.de");
    expect(claims.get("x.dev")).toBe(owner.c.id);
    expect(claims.get("x.de")).toBe(owner.d.id);
    expect(row("c1").sector_key_blocked).toBeNull();
    expect(row("d1").sector_key_blocked).toBeNull();
  });

  it("holds every unblocked key for exactly one owner", () => {
    for (const { sector_key, sector_key_blocked, id } of rows.values()) {
      if (sector_key_blocked) continue;
      expect(claims.has(sector_key), id).toBe(true);
    }
  });
});
