import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import { normalizeIssuer } from "../src/repos/issuer-normalization.js";

const folder = fileURLToPath(new URL("../drizzle/", import.meta.url));
const migration = readFileSync(
  `${folder}0034_organization_issuer_claims.sql`,
  "utf8",
);

async function legacyDatabase() {
  const db = new PGlite();
  await db.waitReady;
  const journal = JSON.parse(
    readFileSync(`${folder}meta/_journal.json`, "utf8"),
  );
  for (const entry of journal.entries) {
    if (entry.idx >= 34) continue;
    await db.exec(readFileSync(`${folder}${entry.tag}.sql`, "utf8"));
  }
  await db.exec(
    `INSERT INTO principals (id,state,assurance) VALUES ('owner','active','verified')`,
  );
  return db;
}

async function seed(
  db: PGlite,
  id: string,
  sso: string | null,
  saml: string | null,
) {
  await db.query(
    `INSERT INTO organizations
    (id,slug,display_name,state,created_by,sso_issuer,saml_issuer)
    VALUES ($1,$1,$1,'active','owner',$2,$3)`,
    [id, sso, saml],
  );
}

async function apply(db: PGlite) {
  await db.transaction(async (tx) => {
    await tx.exec(migration);
  });
}

describe("0034 atomic issuer claims migration", () => {
  it("reproduces legacy ambiguity and refuses to choose an owner", async () => {
    const db = await legacyDatabase();
    try {
      await seed(db, "first", " https://issuer.example/// ", null);
      await seed(db, "second", null, "https://issuer.example/");
      expect(
        (await db.query("SELECT id FROM organizations")).rows,
      ).toHaveLength(2);
      await expect(apply(db)).rejects.toMatchObject({ code: "23505" });
      expect(
        (await db.query("SELECT id FROM organizations ORDER BY id")).rows,
      ).toEqual([{ id: "first" }, { id: "second" }]);
      expect(
        (
          await db.query(
            "SELECT to_regclass('organization_issuer_claims') AS table_name",
          )
        ).rows,
      ).toEqual([{ table_name: null }]);
      await db.exec(
        "UPDATE organizations SET saml_issuer = NULL WHERE id = 'second'",
      );
      await apply(db);
      expect(
        (
          await db.query(
            "SELECT issuer, organization_id FROM organization_issuer_claims",
          )
        ).rows,
      ).toEqual([
        { issuer: "https://issuer.example", organization_id: "first" },
      ]);
    } finally {
      await db.close();
    }
  });

  it("backfills dual-protocol and blank rows with normalization parity", async () => {
    const db = await legacyDatabase();
    try {
      const spelling = "\ufeff\u1680urn:Example:tenant///\u2028\u00a0";
      await seed(db, "dual", spelling, "urn:Example:tenant/");
      await seed(db, "blank", " /// ", null);
      await apply(db);
      expect(
        (
          await db.query(
            "SELECT issuer, organization_id FROM organization_issuer_claims",
          )
        ).rows,
      ).toEqual([
        { issuer: normalizeIssuer(spelling), organization_id: "dual" },
      ]);
      for (const value of [
        spelling,
        "\vhttps://app.dev/\f",
        "\t///\n",
        "urn:case/A",
        "urn:case/a",
        "https://issuer.example / ",
        "https://issuer.example/\u0085",
      ]) {
        const result = await db.query<{ issuer: string }>(
          "SELECT organization_normalized_issuer($1) AS issuer",
          [value],
        );
        expect(result.rows[0]?.issuer).toBe(normalizeIssuer(value));
      }
    } finally {
      await db.close();
    }
  });
});
