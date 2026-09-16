import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ConflictError,
  MemoryRepositories,
  NotFoundError,
  type WalletRegistrationRepository,
} from "../src/index.js";
import { makePrincipal } from "./factories.js";
import { type PgTestContext, createPgTestContext } from "./pg-harness-full.js";
import {
  type Fixture,
  makeInteraction,
  makeRegistration,
} from "./wallet-interaction-test-helpers.js";

function walletRegistrationContract(
  label: string,
  setup: () => Promise<Fixture>,
) {
  describe(`${label}.walletRegistrations`, () => {
    let repo: WalletRegistrationRepository;
    let approverId: string;

    async function fresh() {
      const fx = await setup();
      repo = fx.repos.walletRegistrations;
      approverId = fx.approverId;
    }

    it("round-trips a registration", async () => {
      await fresh();
      const reg = makeRegistration({
        approverPrincipalId: approverId,
        providerSubject: "wallet_subject",
        passReferenceDigest: Uint8Array.from(randomBytes(16)),
        expiresAt: new Date("2026-04-01T00:00:00.000Z"),
      });
      const written = await repo.register(reg);
      expect(written).toEqual(reg);
      const read = await repo.getById(reg.id);
      expect(read).toEqual(reg);
    });

    it("allows one active pass per provider per subject", async () => {
      await fresh();
      const first = makeRegistration();
      await repo.register(first);
      const second = makeRegistration({
        subjectKind: first.subjectKind,
        subjectId: first.subjectId,
      });
      await expect(repo.register(second)).rejects.toBeInstanceOf(ConflictError);

      // Revoking the first frees the slot — a re-issue is legitimate.
      await repo.updateWithVersion(first.id, first.version, {
        status: "revoked",
        revokedAt: new Date(),
      });
      const reissued = await repo.register(second);
      expect(reissued.id).toBe(second.id);
    });

    it("allows one active registration per provider object", async () => {
      await fresh();
      const first = makeRegistration();
      await repo.register(first);
      const clash = makeRegistration({
        providerObjectRef: first.providerObjectRef,
      });
      await expect(repo.register(clash)).rejects.toBeInstanceOf(ConflictError);
    });

    it("finds active registrations and lists an approver's", async () => {
      await fresh();
      const reg = makeRegistration({ approverPrincipalId: approverId });
      await repo.register(reg);
      expect(
        (
          await repo.findActiveBySubject(
            reg.provider,
            reg.subjectKind,
            reg.subjectId,
          )
        )?.id,
      ).toBe(reg.id);
      expect(
        (await repo.findActiveByObjectRef(reg.provider, reg.providerObjectRef))
          ?.id,
      ).toBe(reg.id);
      const listed = await repo.listForApprover(approverId);
      expect(listed.map((r) => r.id)).toContain(reg.id);
    });

    it("moves through its lifecycle under optimistic concurrency", async () => {
      await fresh();
      const reg = await repo.register(makeRegistration());
      const revoked = await repo.updateWithVersion(reg.id, reg.version, {
        status: "revoked",
        revokedAt: new Date("2026-03-04T06:00:00.000Z"),
      });
      expect(revoked.status).toBe("revoked");
      expect(revoked.version).toBe(reg.version + 1);
      // A stale version loses.
      await expect(
        repo.updateWithVersion(reg.id, reg.version, { status: "expired" }),
      ).rejects.toBeInstanceOf(ConflictError);
      await expect(
        repo.updateWithVersion("wreg_missing", 1, { status: "expired" }),
      ).rejects.toBeInstanceOf(NotFoundError);
    });

    it("sweeps active registrations past their expiry", async () => {
      await fresh();
      const past = makeRegistration({
        expiresAt: new Date("2026-03-04T04:00:00.000Z"),
      });
      const future = makeRegistration({
        expiresAt: new Date("2099-01-01T00:00:00.000Z"),
      });
      await repo.register(past);
      await repo.register(future);
      const swept = await repo.expireDue(new Date("2026-03-04T05:00:00.000Z"));
      expect(swept).toBe(1);
      expect((await repo.getById(past.id))?.status).toBe("expired");
      expect((await repo.getById(future.id))?.status).toBe("active");
    });
  });
}

// ---------------------------------------------------------------------------
// Execution reservations (reservation / fencing)
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

walletRegistrationContract("MemoryRepositories", memoryFixture);

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

walletRegistrationContract("PostgresRepositories", postgresFixture);
