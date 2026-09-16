import { randomBytes, randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as schema from "../src/schema/index.js";
import { interactionApprovalQuarantine } from "../src/schema/wallet-interactions.js";
import { makePrincipal } from "./factories.js";
import { type PgTestContext, createPgTestContext } from "./pg-harness-full.js";
import {
  makeInteraction,
  refusalText,
} from "./wallet-interaction-test-helpers.js";

let ctx: PgTestContext;

beforeAll(async () => {
  ctx = await createPgTestContext();
}, 60_000);

afterAll(async () => {
  await ctx.client.close();
});

describe("PostgresRepositories.interactions session-only guard (F12)", () => {
  it("refuses an approved row with no durable proof", async () => {
    const now = new Date("2026-03-04T05:00:00.000Z");
    // The driver hangs the constraint name off `cause`, so the text that says
    // which invariant refused is a level down; matching the top-level "Failed
    // query" would pass for any failure at all.
    const text = await refusalText(() =>
      ctx.db.insert(schema.interactions).values({
        id: `int_${randomBytes(18).toString("base64url")}`,
        kind: "device_authorization",
        status: "approved",
        subjectKind: "device_authorization",
        subjectId: `sub_${randomUUID()}`,
        createdAt: now,
        expiresAt: new Date(now.getTime() + 300_000),
        authorizationDetails: [],
        decidedAt: now,
        version: 1,
      }),
    );
    expect(text).toMatch(/interactions_approved_proof_check/);
  });

  it("admits an approved row that carries its proof", async () => {
    const now = new Date("2026-03-04T05:00:00.000Z");
    const approved = makeInteraction({
      kind: "transaction_authorization",
      status: "approved",
      requestDigest: "sha256:abc",
      approvalProof: {
        mechanism: "webauthn",
        boundDigest: "sha256:abc",
        assurance: "verified",
        verifiedAt: now,
      },
      decidedAt: now,
    });
    const created = await ctx.repos.interactions.create(approved);
    const [row] = await ctx.db
      .select()
      .from(schema.interactions)
      .where(eq(schema.interactions.id, created.id));
    expect(row?.status).toBe("approved");
  });

  it("quarantines a pre-existing session-only approval (migration 0023 DML)", async () => {
    // Reproduce the pre-migration world: temporarily lift the guard, seed a
    // legacy `approved` row with no proof beside a legitimate one, then replay
    // the migration's data statements and assert only the legacy row is
    // quarantined and revoked. The guard is restored before the test returns.
    const now = new Date("2026-03-04T05:00:00.000Z");
    await ctx.db.execute(
      sql`ALTER TABLE "interactions" DROP CONSTRAINT "interactions_approved_proof_check"`,
    );
    try {
      const legacyId = `int_${randomBytes(18).toString("base64url")}`;
      await ctx.db.insert(schema.interactions).values({
        id: legacyId,
        kind: "device_authorization",
        status: "approved",
        subjectKind: "device_authorization",
        subjectId: `sub_${randomUUID()}`,
        createdAt: now,
        expiresAt: new Date(now.getTime() + 300_000),
        authorizationDetails: [],
        decidedAt: now,
        version: 1,
      });
      const legitimate = await ctx.repos.interactions.create(
        makeInteraction({
          kind: "transaction_authorization",
          status: "approved",
          requestDigest: "sha256:legit",
          approvalProof: {
            mechanism: "webauthn",
            boundDigest: "sha256:legit",
            assurance: "verified",
            verifiedAt: now,
          },
          decidedAt: now,
        }),
      );

      await ctx.db.execute(
        sql`INSERT INTO "interaction_approval_quarantine" ("interaction_id", "prior_status", "reason")
            SELECT "id", "status", 'legacy_session_only_approval'
            FROM "interactions"
            WHERE "status" = 'approved' AND "approval_proof" IS NULL
            ON CONFLICT ("interaction_id") DO NOTHING`,
      );
      await ctx.db.execute(
        sql`UPDATE "interactions"
            SET "status" = 'revoked', "revoked_at" = now(), "version" = "version" + 1
            WHERE "status" = 'approved' AND "approval_proof" IS NULL`,
      );

      const quarantined = await ctx.repos.interactions.getById(legacyId);
      expect(quarantined?.status).toBe("revoked");
      const [ledger] = await ctx.db
        .select()
        .from(interactionApprovalQuarantine)
        .where(eq(interactionApprovalQuarantine.interactionId, legacyId));
      expect(ledger?.reason).toBe("legacy_session_only_approval");
      expect(ledger?.priorStatus).toBe("approved");

      // The legitimate approval, which carries its proof, is left untouched.
      const survivor = await ctx.repos.interactions.getById(legitimate.id);
      expect(survivor?.status).toBe("approved");
    } finally {
      await ctx.db.execute(
        sql`ALTER TABLE "interactions" ADD CONSTRAINT "interactions_approved_proof_check" CHECK ("status" <> 'approved' OR "approval_proof" IS NOT NULL)`,
      );
    }
  });
});
