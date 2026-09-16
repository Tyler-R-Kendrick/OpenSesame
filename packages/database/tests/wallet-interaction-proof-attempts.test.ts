import { randomBytes } from "node:crypto";
import type { Interaction } from "@opensesame/os-domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ConflictError,
  type InteractionProofAttemptRepository,
  MemoryRepositories,
} from "../src/index.js";
import { makePrincipal } from "./factories.js";
import { type PgTestContext, createPgTestContext } from "./pg-harness-full.js";
import {
  type Fixture,
  makeInteraction,
  makeProofAttempt,
  refusalText,
} from "./wallet-interaction-test-helpers.js";

function proofAttemptContract(label: string, setup: () => Promise<Fixture>) {
  describe(`${label}.interactionProofAttempts`, () => {
    let repo: InteractionProofAttemptRepository;
    let interaction: Interaction;

    async function fresh() {
      const fx = await setup();
      repo = fx.repos.interactionProofAttempts;
      interaction = await fx.newInteraction();
    }

    it("round-trips an attempt, digest bytes intact", async () => {
      await fresh();
      const attempt = makeProofAttempt(interaction.id, {
        outcome: "accepted",
        assurance: "verified",
        credentialRef: "cred_abc",
      });
      const written = await repo.record(attempt);
      expect(written).toEqual(attempt);

      const read = await repo.getById(attempt.id);
      expect(read).toEqual(attempt);
      expect(read?.proofInputDigest).toEqual(attempt.proofInputDigest);
      expect(read?.createdAt).toBeInstanceOf(Date);
    });

    it("refuses the same proof input twice — the durable replay defence", async () => {
      await fresh();
      const digest = Uint8Array.from(randomBytes(32));
      await repo.record(
        makeProofAttempt(interaction.id, { proofInputDigest: digest }),
      );
      await expect(
        repo.record(
          makeProofAttempt(interaction.id, { proofInputDigest: digest }),
        ),
      ).rejects.toBeInstanceOf(ConflictError);
    });

    it("finalizes exactly once — a second accepted proof collides", async () => {
      await fresh();
      await repo.record(
        makeProofAttempt(interaction.id, { outcome: "accepted" }),
      );
      await expect(
        repo.record(makeProofAttempt(interaction.id, { outcome: "accepted" })),
      ).rejects.toBeInstanceOf(ConflictError);

      const accepted = await repo.getAcceptedForInteraction(interaction.id);
      expect(accepted?.outcome).toBe("accepted");
    });

    it("keeps a durable attempt budget across the count read", async () => {
      await fresh();
      const base = new Date("2026-03-04T05:00:00.000Z");
      for (let i = 0; i < 3; i += 1) {
        await repo.record(
          makeProofAttempt(interaction.id, {
            createdAt: new Date(base.getTime() + i * 1000),
          }),
        );
      }
      // An old attempt outside the window must not count against the budget.
      await repo.record(
        makeProofAttempt(interaction.id, {
          createdAt: new Date(base.getTime() - 3_600_000),
        }),
      );
      const recent = await repo.countRecentForInteraction(interaction.id, base);
      expect(recent).toBe(3);
    });

    it("looks an attempt up by its proof input digest", async () => {
      await fresh();
      const digest = Uint8Array.from(randomBytes(32));
      const attempt = await repo.record(
        makeProofAttempt(interaction.id, { proofInputDigest: digest }),
      );
      const found = await repo.findByProofInputDigest(digest);
      expect(found?.id).toBe(attempt.id);
      expect(
        await repo.findByProofInputDigest(Uint8Array.from(randomBytes(32))),
      ).toBeNull();
    });
  });
}

// ---------------------------------------------------------------------------
// Wallet registrations (registration lifecycle, subject uniqueness)
// ---------------------------------------------------------------------------

async function memoryFixture(): Promise<Fixture> {
  const repos = new MemoryRepositories();
  const approver = await repos.principals.create(makePrincipal());
  return {
    repos,
    approverId: approver.id,
    newInteraction: (overrides) =>
      repos.interactions.create(makeInteraction(overrides)),
  };
}

proofAttemptContract("MemoryRepositories", memoryFixture);

let ctx: PgTestContext;

beforeAll(async () => {
  ctx = await createPgTestContext();
}, 60_000);

afterAll(async () => {
  await ctx.client.close();
});

async function postgresFixture(): Promise<Fixture> {
  const approver = await ctx.repos.principals.create(makePrincipal());
  return {
    repos: ctx.repos,
    approverId: approver.id,
    newInteraction: (overrides) =>
      ctx.repos.interactions.create(makeInteraction(overrides)),
  };
}

proofAttemptContract("PostgresRepositories", postgresFixture);
