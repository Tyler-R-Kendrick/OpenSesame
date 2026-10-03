import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { verifyAuditChain } from "@opensesame/audit";
import { SEALED_FIELD } from "@opensesame/database";
import * as schema from "@opensesame/database/schema";
import { overlapCast } from "@opensesame/os-domain";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createControlPlane } from "../create-app.js";
import { resolveEventSealer } from "../event-sealing.js";

/**
 * The Identity plane seals its event rows (ADR 0150). The rows are read
 * straight from the table: what a dump, a replica or a read-only SQL account
 * would see. The hash chain is computed over the plaintext before the row is
 * sealed, so it must still verify from what the repository lists.
 */
const MIGRATIONS = new URL(
  "../../../../packages/database/drizzle",
  import.meta.url,
).pathname;
const PEPPER = "e".repeat(48);
const SENTINEL = "SENTINEL-hunter2";

let client: PGlite;
let db: ReturnType<typeof drizzle<typeof schema>>;

beforeAll(async () => {
  client = new PGlite();
  db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: MIGRATIONS });
}, 60_000);
afterAll(async () => {
  await client.close();
});

describe("resolveEventSealer", () => {
  it("prefers a dedicated key, then the pepper", () => {
    const dedicated = resolveEventSealer(
      { OPENSESAME_EVENT_KEY: "k".repeat(40), OPENSESAME_CLAIM_PEPPER: PEPPER },
      "process-local",
      true,
    );
    const viaPepper = resolveEventSealer(
      { OPENSESAME_CLAIM_PEPPER: PEPPER },
      "process-local",
      true,
    );
    const sealed = dedicated.seal("t.c", { n: 1 });
    expect(() => viaPepper.open("t.c", sealed)).toThrow();
    expect(viaPepper.open("t.c", viaPepper.seal("t.c", { n: 2 }))).toEqual({
      n: 2,
    });
  });

  it("refuses a database that would outlive its process with no configured key", () => {
    expect(() => resolveEventSealer({}, "process-local", true)).toThrow(
      /OPENSESAME_EVENT_KEY or OPENSESAME_CLAIM_PEPPER/,
    );
  });

  it("lets an in-process database use the process-local pepper", () => {
    const sealer = resolveEventSealer({}, "p".repeat(40), false);
    expect(sealer.open("t.c", sealer.seal("t.c", { n: 3 }))).toEqual({ n: 3 });
  });

  it("refuses a dedicated key that is too short", () => {
    expect(() =>
      resolveEventSealer(
        { OPENSESAME_EVENT_KEY: "short" },
        "p".repeat(40),
        true,
      ),
    ).toThrow(/at least 32/);
  });
});

describe("the control plane over Postgres", () => {
  it("seals audit rows at rest and the hash chain still verifies", async () => {
    const plane = createControlPlane({
      database: overlapCast(db),
      processEnv: { ...process.env, OPENSESAME_CLAIM_PEPPER: PEPPER },
    });
    await plane.ctx.systemPrincipalReady;
    const first = await plane.ctx.repos.auditEvents.append({
      id: randomUUID(),
      occurredAt: new Date(),
      eventType: "test.sealed",
      outcome: "succeeded",
      correlationId: randomUUID(),
      metadata: { reason: SENTINEL },
    });
    const second = await plane.ctx.repos.auditEvents.append({
      id: randomUUID(),
      occurredAt: new Date(),
      eventType: "test.sealed",
      outcome: "succeeded",
      correlationId: randomUUID(),
      metadata: { reason: SENTINEL },
    });

    const raw = await db.select().from(schema.auditEvents);
    const rows = raw.filter(
      (row) => row.id === first.id || row.id === second.id,
    );
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(JSON.stringify(row.metadata)).not.toContain(SENTINEL);
      expect(Object.keys(row.metadata)).toEqual([SEALED_FIELD]);
    }

    const listed = await plane.ctx.repos.auditEvents.list({ limit: 10 });
    expect(listed.find((event) => event.id === first.id)?.metadata).toEqual({
      reason: SENTINEL,
    });
    const verdict = verifyAuditChain(
      listed.filter((event) => event.eventType === "test.sealed").reverse(),
      listed.find((event) => event.id === first.id)?.previousDigest,
    );
    expect(verdict.ok).toBe(true);
  });
});
