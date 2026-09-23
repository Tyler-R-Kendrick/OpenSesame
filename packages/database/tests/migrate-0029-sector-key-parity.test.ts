/**
 * Migration 0029 keys legacy rows in SQL; the issuer keys them with the WHATWG
 * URL parser (`sectorKeyOf` = `pairwiseSectorKey`). Two derivations of one key
 * are only safe if they never disagree, so this runs the migration over a
 * generated corpus of spellings — case, default and odd ports, dot segments,
 * escapes, every C0 control and the Unicode spaces JavaScript's `trim` eats,
 * on either end — and holds every row to one rule: the SQL either derives
 * exactly the issuer's key, or refuses the row under an `unparsed:` key no
 * real key can equal. A wrong key is the one outcome that is never allowed.
 */
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sectorKeyOf } from "../src/client-sector-claims.js";
import {
  type SectorRow,
  databaseBefore0029,
  migrateRest,
} from "./migrate-0029-helpers.js";

const SCHEMES = ["https://", "http://", "HTTPS://", "HtTp://", "ftp://", ""];
const HOSTS = [
  "rp.example",
  "RP.Example",
  "v.example",
  "x.dev",
  "x.de",
  "app.dev",
  "vv",
  "a..b",
  "dot.example.",
  "under_score.example",
  "127.0.0.1",
  "127.1",
  "0x7f.0.0.1",
  "a.1",
  "1e5",
  "xn--nxasmq6b.example",
  "user@creds.example",
  "ex%41mple.com",
];
const PORTS = ["", ":", ":443", ":0443", ":80", ":8443", ":0", ":99999"];
const PATHS = [
  "",
  "/",
  "/v",
  "/nav",
  "/A/b/",
  "/a/../b",
  "/./x",
  "/a/.",
  "//double",
  "/%7Efoo",
  "/a b",
  "/q?x=1",
  "/f#frag",
  "/a'b",
  "/~!$&()*+,;=:@-._",
  "\\back",
];
/** Wrappers the SQL trims (space, tab, CR, LF) and ones it must refuse. */
const PADS = [
  " ",
  "\t",
  "\n",
  "\r",
  "\v",
  "\f",
  "\u0001",
  "\u001f",
  "\u0085",
  "\u00a0",
  "\u2028",
  "\ufeff",
  "v",
  "\t\r\n ",
];

/** The raw spelling after the SQL's own trim (ASCII space, tab, CR, LF). */
function sqlTrim(raw: string): string {
  return raw.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, "");
}

function corpus(): string[] {
  const out = new Set<string>();
  for (const scheme of SCHEMES)
    for (const host of HOSTS)
      for (const port of PORTS)
        for (const path of PATHS) out.add(`${scheme}${host}${port}${path}`);
  const seeds = ["https://rp.example", "https://x.dev/v", "sector_v", "v"];
  for (const seed of seeds) {
    for (const pad of PADS) {
      out.add(`${pad}${seed}`);
      out.add(`${seed}${pad}`);
      out.add(`${pad}${seed}${pad}`);
      out.add(`https://rp${pad}.example`);
    }
  }
  for (const odd of ["https:rp.example", "https:\\\\rp.example", "https:///x"])
    out.add(odd);
  return [...out];
}

describe("drizzle 0029 sector_key backfill parity with sectorKeyOf", () => {
  let client: PGlite;
  let spellings: string[];
  let rows: Map<string, SectorRow>;

  beforeAll(async () => {
    const fresh = await databaseBefore0029();
    client = fresh.client;
    spellings = corpus();
    const ids = spellings.map((_, i) => `p${i}`);
    await client.query(
      `insert into oauth_clients (id, admission_mode, display_name,
         sector_identifier, token_endpoint_auth_method, state)
       select id, 'pre_registered', 'RP', sector, 'none', 'active'
       from unnest($1::text[], $2::text[]) as t(id, sector)`,
      [ids, spellings],
    );
    await migrateRest(fresh.db);
    const result = await client.query<SectorRow>(
      "select id, sector_identifier, sector_key, sector_key_blocked from oauth_clients",
    );
    rows = new Map(result.rows.map((row) => [row.id, row]));
  }, 120_000);

  afterAll(async () => {
    await client.close();
  });

  it("derives the issuer's key or refuses the row, for every spelling", () => {
    const wrong: string[] = [];
    for (const [i, spelling] of spellings.entries()) {
      const row = rows.get(`p${i}`);
      expect(row, JSON.stringify(spelling)).toBeDefined();
      if (!row) continue;
      // The driver's TextDecoder drops a leading BOM when it reads a field.
      expect(row.sector_identifier).toBe(spelling.replace(/^\ufeff/, ""));
      if (row.sector_key_blocked === "unparsed_legacy_spelling") {
        if (row.sector_key !== `unparsed:${sqlTrim(spelling)}`)
          wrong.push(spelling);
      } else if (row.sector_key !== sectorKeyOf(spelling)) {
        wrong.push(spelling);
      }
    }
    expect(wrong.map((s) => JSON.stringify(s))).toEqual([]);
  });

  it("keys the ordinary spellings rather than refusing them", () => {
    const keyed = [...rows.values()].filter(
      (row) => row.sector_key_blocked !== "unparsed_legacy_spelling",
    );
    // Thousands of spellings are provable; the refusals are the odd ones.
    expect(spellings.length).toBeGreaterThan(10_000);
    expect(keyed.length).toBeGreaterThan(spellings.length / 3);
    for (const plain of [
      "https://x.dev",
      "https://x.de",
      "https://v.example/v",
      "https://app.dev/nav",
      "HTTPS://RP.Example:0443/",
      "http://vv:80/v",
    ]) {
      const i = spellings.indexOf(plain);
      expect(i, plain).toBeGreaterThanOrEqual(0);
      const row = rows.get(`p${i}`);
      expect(row?.sector_key_blocked, plain).not.toBe(
        "unparsed_legacy_spelling",
      );
      expect(row?.sector_key, plain).toBe(sectorKeyOf(plain));
    }
  });
});
