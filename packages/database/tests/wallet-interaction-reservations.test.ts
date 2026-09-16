import { randomBytes } from "node:crypto";
import type { Interaction } from "@opensesame/os-domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ConflictError,
  type ExecutionReservationRepository,
  MemoryRepositories,
  NotFoundError,
} from "../src/index.js";
import { makePrincipal } from "./factories.js";
import { type PgTestContext, createPgTestContext } from "./pg-harness-full.js";
import {
  type Fixture,
  makeInteraction,
} from "./wallet-interaction-test-helpers.js";

function executionReservationContract(
  label: string,
  setup: () => Promise<Fixture>,
) {
  describe(`${label}.executionReservations`, () => {
    let repo: ExecutionReservationRepository;
    let interaction: Interaction;

    async function fresh() {
      const fx = await setup();
      repo = fx.repos.executionReservations;
      interaction = await fx.newInteraction();
    }

    function acquireInput(holderRef = "worker_a") {
      return {
        id: `xrsv_${randomBytes(12).toString("base64url")}`,
        interactionId: interaction.id,
        requestDigest: "sha256:deadbeef",
        holderRef,
        leaseExpiresAt: new Date("2026-03-04T05:10:00.000Z"),
      };
    }

    it("assigns monotonically increasing fencing tokens", async () => {
      await fresh();
      const first = await repo.acquire(acquireInput("worker_a"));
      const second = await repo.acquire(acquireInput("worker_b"));
      expect(first.fencingToken).toBe(1);
      expect(second.fencingToken).toBe(2);
      const current = await repo.getCurrent(interaction.id);
      expect(current?.id).toBe(second.id);
    });

    it("commits the current token exactly once", async () => {
      await fresh();
      const res = await repo.acquire(acquireInput());
      const committed = await repo.commit(
        res.id,
        res.fencingToken,
        new Date("2026-03-04T05:05:00.000Z"),
      );
      expect(committed.status).toBe("committed");
      expect(committed.committedAt).toBeInstanceOf(Date);

      // Acquiring again after a commit is refused: the operation already fired.
      await expect(repo.acquire(acquireInput())).rejects.toBeInstanceOf(
        ConflictError,
      );
    });

    it("fences a stale holder out of committing", async () => {
      await fresh();
      const stale = await repo.acquire(acquireInput("worker_a"));
      // A newer reservation supersedes the first. The stale holder must not be
      // able to commit even though it still holds a valid-looking reservation.
      await repo.acquire(acquireInput("worker_b"));
      await expect(
        repo.commit(
          stale.id,
          stale.fencingToken,
          new Date("2026-03-04T05:05:00.000Z"),
        ),
      ).rejects.toBeInstanceOf(ConflictError);
    });

    it("refuses to commit a lapsed lease", async () => {
      await fresh();
      const res = await repo.acquire(acquireInput());
      await expect(
        repo.commit(
          res.id,
          res.fencingToken,
          new Date("2026-03-04T06:00:00.000Z"),
        ),
      ).rejects.toBeInstanceOf(ConflictError);
    });

    it("releases a held reservation and sweeps lapsed ones", async () => {
      await fresh();
      const res = await repo.acquire(acquireInput());
      const released = await repo.release(
        res.id,
        new Date("2026-03-04T05:06:00.000Z"),
      );
      expect(released.status).toBe("released");
      await expect(
        repo.release(res.id, new Date("2026-03-04T05:07:00.000Z")),
      ).rejects.toBeInstanceOf(ConflictError);

      const held = await repo.acquire(acquireInput());
      const swept = await repo.expireDue(new Date("2099-01-01T00:00:00.000Z"));
      expect(swept).toBeGreaterThanOrEqual(1);
      expect((await repo.getById(held.id))?.status).toBe("expired");
    });

    it("reports NotFound for an unknown reservation", async () => {
      await fresh();
      await expect(
        repo.commit("xrsv_missing", 1, new Date()),
      ).rejects.toBeInstanceOf(NotFoundError);
    });
  });
}

// --- Memory ---------------------------------------------------------------

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

executionReservationContract("MemoryRepositories", memoryFixture);

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

executionReservationContract("PostgresRepositories", postgresFixture);
