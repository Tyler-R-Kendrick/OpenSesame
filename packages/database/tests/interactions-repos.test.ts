import { randomBytes, randomUUID } from "node:crypto";
import type {
  ApprovalProof,
  AssuranceRequirement,
  Interaction,
} from "@opensesame/os-domain";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ConflictError,
  type InteractionRepository,
  MemoryRepositories,
  NotFoundError,
} from "../src/index.js";
import * as schema from "../src/schema/index.js";
import { makePrincipal } from "./factories.js";
import { type PgTestContext, createPgTestContext } from "./pg-harness-full.js";

/**
 * Storage contract for the canonical interaction (ADR 0086).
 *
 * The envelope is the one thing a QR, a wallet pass, a phone and a CLI poll
 * all address, so the properties worth testing are the ones that would let two
 * of those surfaces disagree: that a row survives the round trip byte for byte
 * (including the `Date` inside `approvalProof`, which crosses jsonb), that a
 * ceremony has at most one live envelope, and that exactly one of two racing
 * executors gets to spend an approval.
 *
 * Both implementations run the same assertions. Postgres runs against the real
 * migrations in PGlite, so the checks and the partial unique index are the ones
 * production would apply, not a hand-written approximation of them.
 */

function makeAssuranceRequirement(): AssuranceRequirement {
  return {
    subjectKind: "human",
    requireUserVerification: true,
    requirePhishingResistance: true,
    maximumAuthenticationAgeSeconds: 300,
    acceptableAcrValues: ["urn:mace:incommon:iap:silver"],
  };
}

function makeApprovalProof(
  boundDigest: string,
  overrides: Partial<ApprovalProof> = {},
): ApprovalProof {
  return {
    mechanism: "webauthn",
    boundDigest,
    credentialRef: "cred_a1b2c3",
    assurance: "verified",
    verifiedAt: new Date("2026-03-04T05:06:07.000Z"),
    ...overrides,
  };
}

function makeInteraction(overrides: Partial<Interaction> = {}): Interaction {
  const now = new Date("2026-03-04T05:00:00.000Z");
  // The subject's kind tracks the interaction's own: an envelope that fronted
  // one ceremony while claiming to be another would make the live-subject
  // assertions below pass for the wrong reason.
  const kind = overrides.kind ?? "authorization_request";
  return {
    id: `int_${randomBytes(18).toString("base64url")}`,
    kind,
    status: "pending",
    subject: { kind, subjectId: `sub_${randomUUID()}` },
    createdAt: now,
    expiresAt: new Date(now.getTime() + 300_000),
    authorizationDetails: [],
    version: 1,
    ...overrides,
  };
}

/** A row with every optional column populated, for the round-trip assertion. */
function makeFullInteraction(
  approverPrincipalId: string,
  overrides: Partial<Interaction> = {},
): Interaction {
  const digest = "sha256:0f1e2d3c4b5a69788796a5b4c3d2e1f0";
  return makeInteraction({
    kind: "transaction_authorization",
    status: "approved",
    requesterRef: "req_opaque_handle",
    approverPrincipalId,
    requestDigest: digest,
    bindingMessageDigest: "sha256:cafebabedeadbeef",
    bindingMessage: "Send 42.00 EUR to ACME",
    authorizationDetails: [
      { type: "payment_initiation", instructedAmount: { amount: "42.00" } },
    ],
    resourceRef: "res_opaque_handle",
    assuranceRequired: makeAssuranceRequirement(),
    approvalProof: makeApprovalProof(digest),
    presentedAt: new Date("2026-03-04T05:01:00.000Z"),
    decidedAt: new Date("2026-03-04T05:02:00.000Z"),
    ...overrides,
  });
}

/**
 * The suite both implementations must pass.
 *
 * Written against the interface rather than a class so a divergence shows up
 * as a failing assertion instead of as a store nobody exercised — the memory
 * repository is what every unit test in the workspace runs on, and a rule only
 * Postgres enforces is a rule that reaches production untested.
 */
function interactionRepositoryContract(
  label: string,
  setup: () => Promise<{ repo: InteractionRepository; approverId: string }>,
): void {
  describe(`${label}.interactions`, () => {
    it("round-trips every field, with dates still dates", async () => {
      const { repo, approverId } = await setup();
      const interaction = makeFullInteraction(approverId);

      const created = await repo.create(interaction);
      expect(created).toEqual(interaction);

      const read = await repo.getById(interaction.id);
      expect(read).toEqual(interaction);
      // Explicit, because `toEqual` compares a Date against its own ISO string
      // as unequal but compares two structurally identical plain objects as
      // equal — the failure mode this guards is jsonb handing back
      // `verifiedAt` as a string, which every consumer would then have to
      // remember to parse before comparing it against a maximum auth age.
      expect(read?.approvalProof?.verifiedAt).toBeInstanceOf(Date);
      expect(read?.approvalProof?.verifiedAt.toISOString()).toBe(
        "2026-03-04T05:06:07.000Z",
      );
      expect(read?.createdAt).toBeInstanceOf(Date);
      expect(read?.expiresAt).toBeInstanceOf(Date);
      expect(read?.presentedAt).toBeInstanceOf(Date);
      expect(read?.decidedAt).toBeInstanceOf(Date);
      expect(read?.assuranceRequired).toEqual(makeAssuranceRequirement());
      expect(read?.authorizationDetails).toEqual(
        interaction.authorizationDetails,
      );
      expect(read?.subject).toEqual(interaction.subject);
    });

    it("returns null for an unknown id", async () => {
      const { repo } = await setup();
      expect(
        await repo.getById(`int_${randomBytes(18).toString("base64url")}`),
      ).toBeNull();
    });

    it("refuses a duplicate id", async () => {
      const { repo } = await setup();
      const interaction = makeInteraction();
      await repo.create(interaction);
      await expect(repo.create(interaction)).rejects.toBeInstanceOf(
        ConflictError,
      );
    });

    it("allows one live envelope per ceremony", async () => {
      const { repo } = await setup();
      const first = makeInteraction({ kind: "device_authorization" });
      const second = makeInteraction({
        kind: "device_authorization",
        subject: first.subject,
      });
      await repo.create(first);
      // Two QR codes over one device-authorization session is the attack: the
      // second envelope gets approved and the session settles on a question
      // its initiator never saw.
      await expect(repo.create(second)).rejects.toBeInstanceOf(ConflictError);

      // Settling the first releases the slot — a re-issued QR after a lapse is
      // legitimate, and terminal rows are the audit trail, not a lock.
      await repo.updateWithVersion(first.id, first.version, {
        status: "revoked",
        revokedAt: new Date(),
      });
      const reissued = await repo.create(second);
      expect(reissued.id).toBe(second.id);
    });

    it("finds the live interaction for a ceremony and drops it once terminal", async () => {
      const { repo } = await setup();
      const interaction = makeInteraction({ kind: "claim" });
      await repo.create(interaction);

      const live = await repo.getBySubject(
        interaction.subject.kind,
        interaction.subject.subjectId,
      );
      expect(live?.id).toBe(interaction.id);

      await repo.updateWithVersion(interaction.id, interaction.version, {
        status: "denied",
        decidedAt: new Date(),
      });
      // A photographed QR whose interaction settled must not be findable again
      // through the thing it fronted.
      expect(
        await repo.getBySubject(
          interaction.subject.kind,
          interaction.subject.subjectId,
        ),
      ).toBeNull();
      // The row itself survives: settling is not deleting.
      expect((await repo.getById(interaction.id))?.status).toBe("denied");
    });

    it("does not answer with another ceremony's interaction", async () => {
      const { repo } = await setup();
      const interaction = makeInteraction({ kind: "pairing" });
      await repo.create(interaction);
      expect(
        await repo.getBySubject("pairing", `pair_${randomUUID()}`),
      ).toBeNull();
      // Same subject id, different ceremony kind: kinds are not interchangeable.
      expect(
        await repo.getBySubject("claim", interaction.subject.subjectId),
      ).toBeNull();
    });

    it("lists only the approver's inbox, newest first, and filters by status", async () => {
      const { repo, approverId } = await setup();
      const older = makeInteraction({
        approverPrincipalId: approverId,
        status: "awaiting_approval",
        createdAt: new Date("2026-03-04T04:00:00.000Z"),
      });
      const newer = makeInteraction({
        approverPrincipalId: approverId,
        status: "pending",
        createdAt: new Date("2026-03-04T06:00:00.000Z"),
      });
      const someoneElses = makeInteraction();
      await repo.create(older);
      await repo.create(newer);
      await repo.create(someoneElses);

      const inbox = await repo.listForApprover(approverId);
      expect(inbox.map((row) => row.id)).toEqual([newer.id, older.id]);

      const pending = await repo.listForApprover(approverId, {
        status: "pending",
      });
      expect(pending.map((row) => row.id)).toEqual([newer.id]);

      expect(await repo.listForApprover(randomUUID())).toEqual([]);
    });

    it("reports a stale version as a conflict and an unknown id as a miss", async () => {
      const { repo } = await setup();
      const interaction = makeInteraction();
      await repo.create(interaction);

      await expect(
        repo.updateWithVersion(interaction.id, 99, { status: "presented" }),
      ).rejects.toBeInstanceOf(ConflictError);

      await expect(
        repo.updateWithVersion(
          `int_${randomBytes(18).toString("base64url")}`,
          1,
          { status: "presented" },
        ),
      ).rejects.toBeInstanceOf(NotFoundError);
    });

    it("lets exactly one of two racing executors spend an approval", async () => {
      const { repo, approverId } = await setup();
      const interaction = makeFullInteraction(approverId);
      const created = await repo.create(interaction);
      expect(created.status).toBe("approved");

      // Both executors read the same version and both try to consume. The
      // version guard on the UPDATE is the only thing between them and a
      // double spend; `machines/interaction.ts` never sees the second caller.
      const consumedAt = new Date("2026-03-04T05:03:00.000Z");
      const results = await Promise.allSettled([
        repo.updateWithVersion(created.id, created.version, {
          status: "consumed",
          consumedAt,
        }),
        repo.updateWithVersion(created.id, created.version, {
          status: "consumed",
          consumedAt,
        }),
      ]);

      const fulfilled = results.filter((r) => r.status === "fulfilled");
      const rejected = results.filter((r) => r.status === "rejected");
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      for (const failure of rejected) {
        expect(failure.reason).toBeInstanceOf(ConflictError);
      }

      const settled = await repo.getById(created.id);
      expect(settled?.status).toBe("consumed");
      expect(settled?.version).toBe(created.version + 1);
      expect(settled?.consumedAt?.toISOString()).toBe(consumedAt.toISOString());
    });

    it("leaves the consented-to fields exactly where they were", async () => {
      const { repo, approverId } = await setup();
      const interaction = makeFullInteraction(approverId);
      const created = await repo.create(interaction);

      const updated = await repo.updateWithVersion(
        created.id,
        created.version,
        { status: "consumed", consumedAt: new Date() },
      );

      expect(updated.kind).toBe(interaction.kind);
      expect(updated.subject).toEqual(interaction.subject);
      expect(updated.requestDigest).toBe(interaction.requestDigest);
      expect(updated.bindingMessage).toBe(interaction.bindingMessage);
      expect(updated.authorizationDetails).toEqual(
        interaction.authorizationDetails,
      );
      expect(updated.expiresAt.toISOString()).toBe(
        interaction.expiresAt.toISOString(),
      );
      expect(updated.createdAt.toISOString()).toBe(
        interaction.createdAt.toISOString(),
      );
      expect(updated.approvalProof).toEqual(interaction.approvalProof);
    });
  });
}

interactionRepositoryContract("MemoryRepositories", async () => {
  const repos = new MemoryRepositories();
  const approver = await repos.principals.create(makePrincipal());
  return { repo: repos.interactions, approverId: approver.id };
});

describe("MemoryRepositories.interactions isolation", () => {
  it("hands out clones, so a caller cannot reach into the store", async () => {
    const repos = new MemoryRepositories();
    const approver = await repos.principals.create(makePrincipal());
    const interaction = makeFullInteraction(approver.id);

    const created = await repos.interactions.create(interaction);
    // Mutating what a repository returned must not rewrite the stored row.
    // The nested reach matters most: `subject` decides which ceremony this
    // envelope settles, and `approvalProof.boundDigest` is the only thing
    // tying an approval to one request.
    created.status = "revoked";
    created.subject.subjectId = "authreq_attacker";
    created.authorizationDetails.push({ type: "smuggled" });
    if (created.approvalProof) {
      created.approvalProof.boundDigest = "sha256:swapped";
    }
    created.expiresAt.setFullYear(2099);

    const stored = await repos.interactions.getById(interaction.id);
    expect(stored).toEqual(interaction);

    // And the read path clones too, so two readers cannot see each other.
    const first = await repos.interactions.getById(interaction.id);
    first?.authorizationDetails.push({ type: "smuggled" });
    const second = await repos.interactions.getById(interaction.id);
    expect(second?.authorizationDetails).toEqual(
      interaction.authorizationDetails,
    );
  });

  it("does not let a deferred create land before its transaction commits", async () => {
    const repos = new MemoryRepositories();
    const interaction = makeInteraction();
    await repos.transaction(async (uow) => {
      await repos.interactions.create(interaction, uow);
      expect(await repos.interactions.getById(interaction.id)).toBeNull();
    });
    expect((await repos.interactions.getById(interaction.id))?.id).toBe(
      interaction.id,
    );
  });
});

describe("InteractionRepository patch type", () => {
  it("does not admit the fields that describe what was approved", () => {
    // A type-level assertion, not a runtime one: the guarantee is that no
    // caller can compile a patch that rewrites what was consented to. If the
    // `Pick<>` in `interfaces.ts` ever widens, `@ts-expect-error` becomes an
    // unused suppression and `pnpm typecheck` fails here.
    const patch: Parameters<InteractionRepository["updateWithVersion"]>[2] = {
      status: "consumed",
      // @ts-expect-error `requestDigest` is what the approver consented to.
      requestDigest: "sha256:swapped",
    };
    expect(patch.status).toBe("consumed");

    const widened: Parameters<InteractionRepository["updateWithVersion"]>[2] = {
      // @ts-expect-error `expiresAt` would be a movable approval window.
      expiresAt: new Date("2099-01-01T00:00:00.000Z"),
    };
    expect(widened).toBeDefined();
  });
});

let ctx: PgTestContext;

beforeAll(async () => {
  ctx = await createPgTestContext();
}, 60_000);

afterAll(async () => {
  await ctx.client.close();
});

interactionRepositoryContract("PostgresRepositories", async () => {
  const approver = await ctx.repos.principals.create(makePrincipal());
  return { repo: ctx.repos.interactions, approverId: approver.id };
});

/**
 * The text of a refused write, cause chain included.
 *
 * Drizzle re-throws with its own "Failed query" message and hangs the driver's
 * error off `cause`, so the constraint name — the only part that says *which*
 * invariant did the refusing — is a level down. Matching the top-level message
 * instead would pass for any failure at all, a typo in the column list
 * included, which is how a constraint test quietly stops testing a constraint.
 */
async function refusalText<Written>(
  run: () => PromiseLike<Written>,
): Promise<string> {
  try {
    await run();
  } catch (err) {
    const parts: string[] = [];
    let cursor: unknown = err;
    while (cursor instanceof Error) {
      parts.push(cursor.message);
      cursor = cursor.cause;
    }
    return parts.length > 0 ? parts.join("\n") : String(cursor);
  }
  throw new Error("expected the write to be refused");
}

describe("PostgresRepositories.interactions constraints", () => {
  it("keeps the audit trail when the approver's principal is deleted", async () => {
    const approver = await ctx.repos.principals.create(makePrincipal());
    const interaction = makeFullInteraction(approver.id);
    await ctx.repos.interactions.create(interaction);

    await ctx.db
      .delete(schema.principals)
      .where(eq(schema.principals.id, approver.id));

    // `set null`, not `cascade`: an erasure request may cost the approver's
    // identity, but destroying the record that an approval happened at all
    // would be destroying an audit record.
    const survivor = await ctx.repos.interactions.getById(interaction.id);
    expect(survivor?.id).toBe(interaction.id);
    expect(survivor?.approverPrincipalId).toBeUndefined();
    expect(survivor?.requestDigest).toBe(interaction.requestDigest);
    expect(survivor?.approvalProof?.boundDigest).toBe(
      interaction.requestDigest,
    );
  });

  it("refuses a consumption time on a row that is not consumed", async () => {
    const row = makeInteraction();
    const text = await refusalText(() =>
      ctx.db.insert(schema.interactions).values({
        id: row.id,
        kind: row.kind,
        status: "approved",
        subjectKind: row.subject.kind,
        subjectId: row.subject.subjectId,
        createdAt: row.createdAt,
        expiresAt: row.expiresAt,
        decidedAt: new Date(),
        consumedAt: new Date(),
      }),
    );
    expect(text).toMatch(/interactions_consumed_at_check/);
  });

  it("refuses a settled decision with no moment attached", async () => {
    const row = makeInteraction();
    const text = await refusalText(() =>
      ctx.db.insert(schema.interactions).values({
        id: row.id,
        kind: row.kind,
        status: "denied",
        subjectKind: row.subject.kind,
        subjectId: row.subject.subjectId,
        createdAt: row.createdAt,
        expiresAt: row.expiresAt,
      }),
    );
    expect(text).toMatch(/interactions_decided_at_check/);
  });

  it("accepts expired and revoked rows without a decider", async () => {
    // Neither state has one: expiry is the clock running out, and revocation
    // is reachable from `pending`, where nobody has been asked yet.
    for (const status of ["expired", "revoked"] as const) {
      const row = makeInteraction({ status });
      await ctx.repos.interactions.create(row);
      expect((await ctx.repos.interactions.getById(row.id))?.status).toBe(
        status,
      );
    }
  });

  it("refuses a status outside the domain's own set", async () => {
    const row = makeInteraction();
    const text = await refusalText(() =>
      ctx.db.insert(schema.interactions).values({
        id: row.id,
        kind: row.kind,
        status: "definitely_approved",
        subjectKind: row.subject.kind,
        subjectId: row.subject.subjectId,
        createdAt: row.createdAt,
        expiresAt: row.expiresAt,
      }),
    );
    expect(text).toMatch(/interactions_status_check/);
  });
});
