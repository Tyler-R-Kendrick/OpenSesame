import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ConflictError, NotFoundError } from "../src/repos/interfaces.js";
import {
  type Database,
  createPostgresRepositories,
} from "../src/repos/postgres.js";
import * as schema from "../src/schema/index.js";
import {
  makeAuditEvent,
  makeClaim,
  makeClaimItem,
  makeIdentity,
  makePrincipal,
} from "./factories.js";
import { type PgTestContext, createPgTestContext } from "./pg-harness-full.js";

let ctx: PgTestContext;

beforeAll(async () => {
  ctx = await createPgTestContext();
}, 60_000);

afterAll(async () => {
  await ctx.client.close();
});

describe("PostgresRepositories.principals", () => {
  it("creates and reads back a principal with optional timestamps", async () => {
    const principal = makePrincipal({
      state: "active",
      assurance: "verified",
      verifiedAt: new Date(),
      suspendedAt: new Date(),
    });
    const created = await ctx.repos.principals.create(principal);
    expect(created).toEqual(principal);
    expect(await ctx.repos.principals.getById(principal.id)).toEqual(principal);
  });

  it("omits optional timestamps when they are not set", async () => {
    const created = await ctx.repos.principals.create(makePrincipal());
    expect(created.verifiedAt).toBeUndefined();
    expect(created.suspendedAt).toBeUndefined();
  });

  it("maps duplicate ids to ConflictError", async () => {
    const principal = makePrincipal();
    await ctx.repos.principals.create(principal);
    await expect(ctx.repos.principals.create(principal)).rejects.toBeInstanceOf(
      ConflictError,
    );
  });

  it("returns null for an unknown id", async () => {
    expect(await ctx.repos.principals.getById(randomUUID())).toBeNull();
  });

  it("updates with optimistic concurrency and partial patches", async () => {
    const created = await ctx.repos.principals.create(
      makePrincipal({ state: "provisional" }),
    );

    const updated = await ctx.repos.principals.update(
      created.id,
      { state: "active", assurance: "verified" },
      1,
    );
    expect(updated.version).toBe(2);
    expect(updated.state).toBe("active");
    expect(updated.assurance).toBe("verified");

    const stamped = new Date();
    const again = await ctx.repos.principals.update(
      created.id,
      {
        verifiedAt: stamped,
        suspendedAt: stamped,
        updatedAt: stamped,
      },
      2,
    );
    expect(again.version).toBe(3);
    expect(again.verifiedAt).toEqual(stamped);
    expect(again.suspendedAt).toEqual(stamped);
    expect(again.updatedAt).toEqual(stamped);
  });

  it("throws NotFoundError when updating a missing principal", async () => {
    await expect(
      ctx.repos.principals.update(randomUUID(), { state: "closed" }, 1),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("throws ConflictError on a version mismatch", async () => {
    const created = await ctx.repos.principals.create(makePrincipal());
    await expect(
      ctx.repos.principals.update(created.id, { state: "closed" }, 99),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it("deletes only unlinked provisional principals", async () => {
    // Not found at all.
    expect(
      await ctx.repos.principals.deleteUnlinkedProvisional(randomUUID()),
    ).toBe(false);

    // Wrong lifecycle state.
    const active = await ctx.repos.principals.create(
      makePrincipal({ state: "active" }),
    );
    expect(
      await ctx.repos.principals.deleteUnlinkedProvisional(active.id),
    ).toBe(false);

    // Provisional but still linked to an external identity.
    const linked = await ctx.repos.principals.create(
      makePrincipal({ state: "provisional" }),
    );
    await ctx.repos.externalIdentities.create(makeIdentity(linked.id));
    expect(
      await ctx.repos.principals.deleteUnlinkedProvisional(linked.id),
    ).toBe(false);

    // Provisional and unlinked: gone.
    const provisional = await ctx.repos.principals.create(
      makePrincipal({ state: "provisional" }),
    );
    expect(
      await ctx.repos.principals.deleteUnlinkedProvisional(provisional.id),
    ).toBe(true);
    expect(await ctx.repos.principals.getById(provisional.id)).toBeNull();
  });
});

describe("PostgresRepositories.externalIdentities", () => {
  it("round-trips an identity with every optional field", async () => {
    const principal = await ctx.repos.principals.create(makePrincipal());
    const identity = makeIdentity(principal.id, {
      tenant: "acme",
      displayHint: "Ada",
      emailNormalized: "ada@example.com",
      emailVerified: true,
      lastAuthenticatedAt: new Date(),
      metadata: { nested: { ok: true } },
    });
    const created = await ctx.repos.externalIdentities.create(identity);
    expect(created).toEqual(identity);
    expect(await ctx.repos.externalIdentities.getById(identity.id)).toEqual(
      identity,
    );
  });

  it("normalizes a missing tenant to the empty string", async () => {
    const principal = await ctx.repos.principals.create(makePrincipal());
    const identity = makeIdentity(principal.id);
    const created = await ctx.repos.externalIdentities.create(identity);
    expect(created.tenant).toBeUndefined();

    const found = await ctx.repos.externalIdentities.findByTuple({
      kind: identity.kind,
      issuer: identity.issuer,
      subject: identity.subject,
    });
    expect(found?.id).toBe(identity.id);
  });

  it("rejects a duplicate kind+issuer+tenant+subject tuple", async () => {
    const principal = await ctx.repos.principals.create(makePrincipal());
    const first = makeIdentity(principal.id, {
      tenant: "acme",
      subject: "user-dup",
    });
    await ctx.repos.externalIdentities.create(first);
    await expect(
      ctx.repos.externalIdentities.create(
        makeIdentity(principal.id, { tenant: "acme", subject: "user-dup" }),
      ),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it("returns null for unknown lookups", async () => {
    expect(await ctx.repos.externalIdentities.getById(randomUUID())).toBeNull();
    expect(
      await ctx.repos.externalIdentities.findByTuple({
        kind: "oidc",
        issuer: "https://nobody.example",
        subject: "ghost",
      }),
    ).toBeNull();
  });

  it("lists by principal and by normalized email", async () => {
    const a = await ctx.repos.principals.create(makePrincipal());
    const b = await ctx.repos.principals.create(makePrincipal());
    const email = `${randomUUID()}@example.com`;
    await ctx.repos.externalIdentities.create(
      makeIdentity(a.id, { emailNormalized: email }),
    );
    await ctx.repos.externalIdentities.create(
      makeIdentity(b.id, { emailNormalized: email }),
    );

    const byPrincipal = await ctx.repos.externalIdentities.listByPrincipal(
      a.id,
    );
    expect(byPrincipal).toHaveLength(1);
    expect(byPrincipal[0]?.principalId).toBe(a.id);

    const byEmail =
      await ctx.repos.externalIdentities.listByEmailNormalized(email);
    expect(byEmail).toHaveLength(2);
  });

  it("deletes by id and reports whether a row existed", async () => {
    const principal = await ctx.repos.principals.create(makePrincipal());
    const identity = await ctx.repos.externalIdentities.create(
      makeIdentity(principal.id),
    );
    expect(await ctx.repos.externalIdentities.deleteById(identity.id)).toBe(
      true,
    );
    expect(await ctx.repos.externalIdentities.deleteById(identity.id)).toBe(
      false,
    );
  });
});

describe("PostgresRepositories.betterAuthSubjects", () => {
  it("links and looks up a better-auth user", async () => {
    const principal = await ctx.repos.principals.create(makePrincipal());
    const row = {
      betterAuthUserId: `ba_${randomUUID()}`,
      principalId: principal.id,
      linkedAt: new Date(),
    };
    const linked = await ctx.repos.betterAuthSubjects.link(row);
    expect(linked).toEqual(row);
    expect(
      await ctx.repos.betterAuthSubjects.getByBetterAuthUserId(
        row.betterAuthUserId,
      ),
    ).toEqual(row);
  });

  it("rejects a duplicate link and misses unknown users", async () => {
    const principal = await ctx.repos.principals.create(makePrincipal());
    const row = {
      betterAuthUserId: `ba_${randomUUID()}`,
      principalId: principal.id,
      linkedAt: new Date(),
    };
    await ctx.repos.betterAuthSubjects.link(row);
    await expect(ctx.repos.betterAuthSubjects.link(row)).rejects.toBeInstanceOf(
      ConflictError,
    );
    expect(
      await ctx.repos.betterAuthSubjects.getByBetterAuthUserId("ba_nope"),
    ).toBeNull();
  });
});

describe("PostgresRepositories.claimSessions", () => {
  async function seedCreatorRefs() {
    const creator = await ctx.repos.principals.create(makePrincipal());
    const completer = await ctx.repos.principals.create(makePrincipal());
    const agentId = randomUUID();
    await ctx.db.insert(schema.agents).values({
      id: agentId,
      ownerPrincipalId: creator.id,
      displayName: "agent",
      state: "claimed",
    });
    const instanceId = randomUUID();
    await ctx.db.insert(schema.agentInstances).values({
      id: instanceId,
      agentId,
      publicKeyJkt: `jkt_${randomUUID()}`,
    });
    return { creator, completer, agentId, instanceId };
  }

  it("creates and reads back a session with every optional field", async () => {
    const { creator, completer, agentId, instanceId } = await seedCreatorRefs();
    const now = new Date();
    const session = makeClaim({
      creatorPrincipalId: creator.id,
      creatorAgentId: agentId,
      creatorInstanceId: instanceId,
      userCodeDigest: new Uint8Array([9, 9]),
      proofKeyJkt: "jkt_proof",
      requestedDestination: { uri: "https://rp.example" },
      requestedGrant: { scope: "vault:read" },
      presentedAt: now,
      authenticatedAt: now,
      reviewedAt: now,
      completedAt: now,
      revokedAt: now,
      completedByPrincipalId: completer.id,
      state: "completed",
    });
    const created = await ctx.repos.claimSessions.create(session);
    expect(created).toEqual(session);
    expect(await ctx.repos.claimSessions.getById(session.id)).toEqual(session);
  });

  it("omits optional fields when unset", async () => {
    const created = await ctx.repos.claimSessions.create(makeClaim());
    expect(created.creatorPrincipalId).toBeUndefined();
    expect(created.userCodeDigest).toBeUndefined();
    expect(created.requestedGrant).toBeUndefined();
    expect(await ctx.repos.claimSessions.getById(randomUUID())).toBeNull();
  });

  it("maps duplicate ids to ConflictError", async () => {
    const session = makeClaim();
    await ctx.repos.claimSessions.create(session);
    await expect(
      ctx.repos.claimSessions.create(session),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it("applies every patch field under version CAS", async () => {
    const { creator, completer, agentId, instanceId } = await seedCreatorRefs();
    const created = await ctx.repos.claimSessions.create(makeClaim());
    const now = new Date();
    const patch = {
      type: "device" as const,
      state: "completed" as const,
      creatorPrincipalId: creator.id,
      creatorAgentId: agentId,
      creatorInstanceId: instanceId,
      tokenDigest: new Uint8Array([7, 7, 7]),
      userCodeDigest: new Uint8Array([8]),
      proofKeyJkt: "jkt_new",
      targetManifest: { v: 2 },
      targetManifestDigest: "sha256:beef",
      requestedDestination: { uri: "https://dest.example" },
      requestedGrant: { scope: "x" },
      presentedAt: now,
      authenticatedAt: now,
      reviewedAt: now,
      completedAt: now,
      expiresAt: new Date(now.getTime() + 5_000),
      revokedAt: now,
      completedByPrincipalId: completer.id,
    };
    const updated = await ctx.repos.claimSessions.updateWithVersion(
      created.id,
      1,
      patch,
    );
    expect(updated.version).toBe(2);
    expect(updated.type).toBe("device");
    expect(updated.state).toBe("completed");
    expect(updated.creatorPrincipalId).toBe(creator.id);
    expect(updated.creatorAgentId).toBe(agentId);
    expect(updated.creatorInstanceId).toBe(instanceId);
    expect(updated.tokenDigest).toEqual(patch.tokenDigest);
    expect(updated.userCodeDigest).toEqual(patch.userCodeDigest);
    expect(updated.proofKeyJkt).toBe("jkt_new");
    expect(updated.targetManifest).toEqual({ v: 2 });
    expect(updated.targetManifestDigest).toBe("sha256:beef");
    expect(updated.requestedDestination).toEqual({
      uri: "https://dest.example",
    });
    expect(updated.requestedGrant).toEqual({ scope: "x" });
    expect(updated.presentedAt).toEqual(now);
    expect(updated.expiresAt).toEqual(patch.expiresAt);
    expect(updated.revokedAt).toEqual(now);
    expect(updated.completedByPrincipalId).toBe(completer.id);
    // An empty patch still bumps the version.
    const bumped = await ctx.repos.claimSessions.updateWithVersion(
      created.id,
      2,
      {},
    );
    expect(bumped.version).toBe(3);
  });

  it("distinguishes missing rows from version conflicts", async () => {
    await expect(
      ctx.repos.claimSessions.updateWithVersion(randomUUID(), 1, {}),
    ).rejects.toBeInstanceOf(NotFoundError);

    const created = await ctx.repos.claimSessions.create(makeClaim());
    await expect(
      ctx.repos.claimSessions.updateWithVersion(created.id, 42, {}),
    ).rejects.toBeInstanceOf(ConflictError);
  });
});

describe("PostgresRepositories.claimItems", () => {
  it("creates items and lists them by claim", async () => {
    const claim = await ctx.repos.claimSessions.create(makeClaim());
    const other = await ctx.repos.claimSessions.create(makeClaim());
    const item = makeClaimItem(claim.id, { dependencies: ["dep-1"] });
    const created = await ctx.repos.claimItems.create(item);
    expect(created).toEqual(item);
    await ctx.repos.claimItems.create(makeClaimItem(other.id));

    const listed = await ctx.repos.claimItems.listByClaim(claim.id);
    expect(listed).toEqual([item]);
  });
});

describe("PostgresRepositories.auditEvents", () => {
  it("appends events with full and minimal shapes", async () => {
    const full = makeAuditEvent({
      principalId: `prn_${randomUUID()}`,
      actorType: "agent",
      actorId: "actor-1",
      agentInstanceId: "inst-1",
      clientId: "client-1",
      organizationId: "org-1",
      projectId: "proj-1",
      claimId: "claim-1",
      sessionId: "sess-1",
      targetType: "resource",
      targetId: "res-1",
      causationId: randomUUID(),
      previousDigest: "sha256:prev",
      digest: "sha256:self",
      metadata: { k: "v" },
    });
    const appended = await ctx.repos.auditEvents.append(full);
    expect(appended).toEqual(full);

    const minimal = makeAuditEvent({ actorType: "system" });
    const appendedMinimal = await ctx.repos.auditEvents.append(minimal);
    expect(appendedMinimal.principalId).toBeUndefined();
    expect(appendedMinimal.actorId).toBeUndefined();
    expect(appendedMinimal.digest).toBeUndefined();
  });

  it("lists newest first with principal filter and limit", async () => {
    const principalId = `prn_${randomUUID()}`;
    for (let i = 0; i < 3; i += 1) {
      await ctx.repos.auditEvents.append(
        makeAuditEvent({ principalId, eventType: `ev_${i}` }),
      );
    }
    await ctx.repos.auditEvents.append(makeAuditEvent());

    const all = await ctx.repos.auditEvents.list({ principalId });
    expect(all.map((e) => e.eventType)).toEqual(["ev_2", "ev_1", "ev_0"]);

    const limited = await ctx.repos.auditEvents.list({
      principalId,
      limit: 2,
    });
    expect(limited).toHaveLength(2);

    const unfiltered = await ctx.repos.auditEvents.list();
    expect(unfiltered.length).toBeGreaterThan(0);
  });
});

describe("PostgresRepositories.outbox", () => {
  function makeEvent(id = `ob_${randomUUID()}`) {
    return {
      id,
      aggregateType: "principal",
      aggregateId: `prn_${randomUUID()}`,
      eventType: "principal.created",
      payload: { ok: true },
    };
  }

  it("appends outside a transaction with defaults", async () => {
    const appended = await ctx.repos.outbox.append(makeEvent());
    expect(appended.attempts).toBe(0);
    expect(appended.publishedAt).toBeUndefined();
    expect(appended.payload).toEqual({ ok: true });
  });

  it("generates an id when the event id is empty", async () => {
    const appended = await ctx.repos.outbox.append({
      ...makeEvent(""),
      availableAt: new Date(),
    });
    expect(appended.id).not.toBe("");
  });

  it("lists unpublished rows in availability order and honors the limit", async () => {
    const now = Date.now();
    const late = await ctx.repos.outbox.append({
      ...makeEvent(),
      availableAt: new Date(now + 60_000),
    });
    const early = await ctx.repos.outbox.append({
      ...makeEvent(),
      availableAt: new Date(now - 60_000),
    });
    const listed = await ctx.repos.outbox.listUnpublished(100);
    const ids = listed.map((e) => e.id);
    expect(ids.indexOf(early.id)).toBeLessThan(ids.indexOf(late.id));

    const limited = await ctx.repos.outbox.listUnpublished(1);
    expect(limited).toHaveLength(1);
  });

  it("claim hides a row until the hold expires", async () => {
    const now = new Date();
    // `availableAt` defaults to the database clock at INSERT, which is strictly
    // later than a `now` captured before the append. Claiming as of that `now`
    // then finds the row only when both land in the same tick — true on a fast
    // machine, false on a loaded runner, where the claim comes back empty and
    // `mine` is undefined. Pinning the row into the past makes this a test of
    // the hold rather than of which clock won the race.
    const event = await ctx.repos.outbox.append({
      ...makeEvent(),
      availableAt: new Date(now.getTime() - 1_000),
    });

    const claimed = await ctx.repos.outbox.claimUnpublished(100, now, 30_000);
    const mine = claimed.find((e) => e.id === event.id);
    expect(mine?.attempts).toBe(1);
    expect(mine?.lastError).toMatch(/^claim:/);

    // Held rows are hidden from both claim and list while the hold is live.
    const again = await ctx.repos.outbox.claimUnpublished(100, now, 30_000);
    expect(again.some((e) => e.id === event.id)).toBe(false);
    const listed = await ctx.repos.outbox.listUnpublished(100);
    expect(listed.some((e) => e.id === event.id)).toBe(false);

    // An expired hold makes the row claimable again.
    const later = new Date(now.getTime() + 31_000);
    const reclaims = await ctx.repos.outbox.claimUnpublished(
      100,
      later,
      30_000,
    );
    expect(reclaims.some((e) => e.id === event.id)).toBe(true);
  });

  it("does not claim rows that are not yet available", async () => {
    const future = new Date(Date.now() + 3_600_000);
    const event = await ctx.repos.outbox.append({
      ...makeEvent(),
      availableAt: future,
    });
    const claimed = await ctx.repos.outbox.claimUnpublished(
      100,
      new Date(),
      30_000,
    );
    expect(claimed.some((e) => e.id === event.id)).toBe(false);
  });

  it("releaseClaim records an error or clears the claim", async () => {
    const now = new Date();
    const a = await ctx.repos.outbox.append(makeEvent());
    const b = await ctx.repos.outbox.append(makeEvent());
    await ctx.repos.outbox.claimUnpublished(100, now, 30_000);

    await ctx.repos.outbox.releaseClaim(a.id, "nats down");
    await ctx.repos.outbox.releaseClaim(b.id);

    const listed = await ctx.repos.outbox.listUnpublished(100);
    const rowA = listed.find((e) => e.id === a.id);
    const rowB = listed.find((e) => e.id === b.id);
    expect(rowA?.lastError).toBe("nats down");
    expect(rowB?.lastError).toBeUndefined();
  });

  it("markPublished stamps once, ignores repeats, and misses unknown ids", async () => {
    const event = await ctx.repos.outbox.append(makeEvent());
    await ctx.repos.outbox.markPublished(event.id);
    // Second call is a silent no-op, not an error.
    await ctx.repos.outbox.markPublished(event.id, new Date());
    // Releasing a published row leaves last_error alone.
    await ctx.repos.outbox.releaseClaim(event.id, "too late");

    const listed = await ctx.repos.outbox.listUnpublished(100);
    expect(listed.some((e) => e.id === event.id)).toBe(false);

    await expect(
      ctx.repos.outbox.markPublished(`ob_${randomUUID()}`),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("PostgresRepositories.transaction", () => {
  it("commits domain writes and outbox events atomically", async () => {
    const principal = makePrincipal();
    const outboxId = `ob_${randomUUID()}`;
    await ctx.repos.transaction(async (uow) => {
      await ctx.repos.principals.create(principal, uow);
      await uow.appendOutbox({
        id: outboxId,
        aggregateType: "principal",
        aggregateId: principal.id,
        eventType: "principal.created",
        payload: {},
      });
    });
    expect(await ctx.repos.principals.getById(principal.id)).not.toBeNull();
    const unpublished = await ctx.repos.outbox.listUnpublished();
    expect(unpublished.map((e) => e.id)).toContain(outboxId);
  });

  it("rolls everything back when the work throws", async () => {
    const principal = makePrincipal();
    await expect(
      ctx.repos.transaction(async (uow) => {
        await ctx.repos.principals.create(principal, uow);
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await ctx.repos.principals.getById(principal.id)).toBeNull();
  });
  it("routes outbox.append through an active unit of work", async () => {
    const id = `ob_${randomUUID()}`;
    await ctx.repos.transaction(async (uow) => {
      await ctx.repos.outbox.append(
        {
          id,
          aggregateType: "principal",
          aggregateId: `prn_${randomUUID()}`,
          eventType: "principal.created",
          payload: {},
        },
        uow,
      );
    });
    const unpublished = await ctx.repos.outbox.listUnpublished();
    expect(unpublished.map((e) => e.id)).toContain(id);
  });
});

describe("createPostgresRepositories", () => {
  it("wraps a database handle", () => {
    const repos = createPostgresRepositories(ctx.db);
    expect(repos).toBeDefined();
  });
});
