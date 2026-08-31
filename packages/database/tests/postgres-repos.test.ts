import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ConflictError, NotFoundError } from "../src/repos/interfaces.js";
import {
  type Database,
  createPostgresRepositories,
} from "../src/repos/postgres.js";
import * as schema from "../src/schema/index.js";
import {
  makeApprovalActivation,
  makeApprovalReceipt,
  makeAuditEvent,
  makeBindingChallenge,
  makeCallbackReplay,
  makeChannelBinding,
  makeClaim,
  makeClaimItem,
  makeComparisonChallenge,
  makeIdentity,
  makeNotificationDelivery,
  makeNotificationPreferences,
  makePrincipal,
  makePushSubscription,
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

/* ------------------------------------------------------------------ *
 * External notification channels and approval ceremonies (ADR 0081)
 *
 * The Postgres half of the parity suite. Every assertion below mirrors one in
 * `notification-repos.test.ts`: a rule the two stores disagree about is a rule
 * neither of them really has.
 * ------------------------------------------------------------------ */

async function seedPrincipal(): Promise<string> {
  const principal = await ctx.repos.principals.create(makePrincipal());
  return principal.id;
}

describe("PostgresRepositories.channelBindings", () => {
  it("adversarial: a matching subject in the wrong tenant resolves to nothing", async () => {
    const principalId = await seedPrincipal();
    const tenant = `T_ACME_${randomUUID().slice(0, 8)}`;
    const subject = `U_ALICE_${randomUUID().slice(0, 8)}`;
    const binding = await ctx.repos.channelBindings.create(
      makeChannelBinding(principalId, {
        providerTenantId: tenant,
        providerSubjectId: subject,
      }),
    );

    expect(
      await ctx.repos.channelBindings.findByProviderIdentity(
        "slack",
        "slack",
        `T_EVIL_${randomUUID().slice(0, 8)}`,
        subject,
      ),
    ).toBeNull();
    expect(
      await ctx.repos.channelBindings.findByProviderIdentity(
        "slack",
        "slack",
        tenant,
        `U_MALLORY_${randomUUID().slice(0, 8)}`,
      ),
    ).toBeNull();
    expect(
      await ctx.repos.channelBindings.findByProviderIdentity(
        "telegram",
        "slack",
        tenant,
        subject,
      ),
    ).toBeNull();
    const found = await ctx.repos.channelBindings.findByProviderIdentity(
      "slack",
      "slack",
      tenant,
      subject,
    );
    expect(found?.id).toBe(binding.id);
  });

  it("adversarial: an empty subject matches nothing", async () => {
    const principalId = await seedPrincipal();
    const tenant = `T_ACME_${randomUUID().slice(0, 8)}`;
    await ctx.repos.channelBindings.create(
      makeChannelBinding(principalId, { providerTenantId: tenant }),
    );
    expect(
      await ctx.repos.channelBindings.findByProviderIdentity(
        "slack",
        "slack",
        tenant,
        "",
      ),
    ).toBeNull();
  });

  it("adversarial: an empty subject cannot even be stored", async () => {
    const principalId = await seedPrincipal();
    // `channel_bindings_provider_subject_id_check`. The memory store raises
    // the same refusal from its own guard.
    await expect(
      ctx.repos.channelBindings.create(
        makeChannelBinding(principalId, { providerSubjectId: "" }),
      ),
    ).rejects.toBeInstanceOf(Error);
  });

  it("adversarial: the same provider identity cannot be bound twice", async () => {
    const principalId = await seedPrincipal();
    const tenant = `T_ACME_${randomUUID().slice(0, 8)}`;
    const subject = `U_ALICE_${randomUUID().slice(0, 8)}`;
    await ctx.repos.channelBindings.create(
      makeChannelBinding(principalId, {
        providerTenantId: tenant,
        providerSubjectId: subject,
      }),
    );
    await expect(
      ctx.repos.channelBindings.create(
        makeChannelBinding(principalId, {
          providerTenantId: tenant,
          providerSubjectId: subject,
        }),
      ),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it("property: updateWithVersion with a stale version always conflicts", async () => {
    const principalId = await seedPrincipal();
    const created = await ctx.repos.channelBindings.create(
      makeChannelBinding(principalId),
    );
    for (const stale of [0, 2, 5, 99]) {
      await expect(
        ctx.repos.channelBindings.updateWithVersion(created.id, stale, {
          state: "revoked",
        }),
      ).rejects.toBeInstanceOf(ConflictError);
    }
    const revoked = await ctx.repos.channelBindings.updateWithVersion(
      created.id,
      created.version,
      { state: "revoked", revokedAt: new Date() },
    );
    expect(revoked.version).toBe(2);
    expect(revoked.state).toBe("revoked");
    await expect(
      ctx.repos.channelBindings.updateWithVersion(randomUUID(), 1, {
        state: "revoked",
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("chaos: a stored binding is a copy, so mutating it cannot rewrite the row", async () => {
    const principalId = await seedPrincipal();
    const created = await ctx.repos.channelBindings.create(
      makeChannelBinding(principalId),
    );
    created.state = "revoked";
    created.displayLabel = "smuggled";
    created.metadata.smuggled = "yes";

    const fresh = await ctx.repos.channelBindings.getById(created.id);
    expect(fresh?.state).toBe("active");
    expect(fresh?.displayLabel).toBeUndefined();
    expect(fresh?.metadata).toEqual({});
  });

  it("contract: a principal's bindings list is their own", async () => {
    const principalId = await seedPrincipal();
    const otherId = await seedPrincipal();
    await ctx.repos.channelBindings.create(makeChannelBinding(principalId));
    await ctx.repos.channelBindings.create(makeChannelBinding(otherId));

    const listed =
      await ctx.repos.channelBindings.listForPrincipal(principalId);
    expect(listed).toHaveLength(1);
    expect(listed[0]?.principalId).toBe(principalId);
  });
});

describe("PostgresRepositories.channelBindingChallenges", () => {
  it("adversarial: completing a challenge twice only works once", async () => {
    const principalId = await seedPrincipal();
    const challenge = await ctx.repos.channelBindingChallenges.create(
      makeBindingChallenge(principalId),
    );
    const at = new Date();

    const won = await ctx.repos.channelBindingChallenges.complete(
      challenge.id,
      at,
    );
    expect(won?.completedAt).toEqual(at);
    expect(
      await ctx.repos.channelBindingChallenges.complete(
        challenge.id,
        new Date(),
      ),
    ).toBeNull();
  });

  it("contract: the attempt budget is spent durably and then refused", async () => {
    const principalId = await seedPrincipal();
    const now = new Date();
    const challenge = await ctx.repos.channelBindingChallenges.create(
      makeBindingChallenge(principalId, { maxAttempts: 2 }),
    );

    expect(
      (
        await ctx.repos.channelBindingChallenges.consumeAttempt(
          challenge.id,
          now,
        )
      )?.attempts,
    ).toBe(1);
    expect(
      (
        await ctx.repos.channelBindingChallenges.consumeAttempt(
          challenge.id,
          now,
        )
      )?.attempts,
    ).toBe(2);
    expect(
      await ctx.repos.channelBindingChallenges.consumeAttempt(
        challenge.id,
        now,
      ),
    ).toBeNull();
    expect(
      (await ctx.repos.channelBindingChallenges.getById(challenge.id))
        ?.attempts,
    ).toBe(2);
  });

  it("contract: an expired challenge spends nothing", async () => {
    const principalId = await seedPrincipal();
    const now = new Date();
    const challenge = await ctx.repos.channelBindingChallenges.create(
      makeBindingChallenge(principalId, {
        expiresAt: new Date(now.getTime() - 1_000),
      }),
    );
    expect(
      await ctx.repos.channelBindingChallenges.consumeAttempt(
        challenge.id,
        now,
      ),
    ).toBeNull();
  });
});

describe("PostgresRepositories.notificationPreferences", () => {
  it("contract: preferences round-trip and upsert replaces in place", async () => {
    const principalId = await seedPrincipal();
    expect(await ctx.repos.notificationPreferences.get(principalId)).toBeNull();

    await ctx.repos.notificationPreferences.upsert(
      makeNotificationPreferences(principalId),
    );
    const stored = await ctx.repos.notificationPreferences.get(principalId);
    expect(stored?.byClass).toEqual({
      authorization_request: { channels: ["in_app"], fanOut: false },
    });

    await ctx.repos.notificationPreferences.upsert(
      makeNotificationPreferences(principalId, {
        byClass: {
          security_event: { channels: ["in_app", "slack"], fanOut: true },
        },
        version: 2,
      }),
    );
    const updated = await ctx.repos.notificationPreferences.get(principalId);
    expect(updated?.version).toBe(2);
    expect(updated?.byClass).toEqual({
      security_event: { channels: ["in_app", "slack"], fanOut: true },
    });
  });
});

describe("PostgresRepositories.notificationDeliveries", () => {
  it("contract: existsForEvent is true after enqueue and a duplicate fan-out conflicts", async () => {
    const principalId = await seedPrincipal();
    const outboxEventId = randomUUID();
    const bindingId = `chb_${randomUUID()}`;
    await ctx.repos.notificationDeliveries.enqueue(
      makeNotificationDelivery(principalId, { outboxEventId, bindingId }),
    );

    expect(
      await ctx.repos.notificationDeliveries.existsForEvent(
        outboxEventId,
        "slack",
        bindingId,
      ),
    ).toBe(true);
    expect(
      await ctx.repos.notificationDeliveries.existsForEvent(
        outboxEventId,
        "slack",
        `chb_${randomUUID()}`,
      ),
    ).toBe(false);
    expect(
      await ctx.repos.notificationDeliveries.existsForEvent(
        outboxEventId,
        "telegram",
        bindingId,
      ),
    ).toBe(false);

    await expect(
      ctx.repos.notificationDeliveries.enqueue(
        makeNotificationDelivery(principalId, { outboxEventId, bindingId }),
      ),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it("contract: a destination-less delivery still keys on the empty string", async () => {
    const principalId = await seedPrincipal();
    const outboxEventId = randomUUID();
    await ctx.repos.notificationDeliveries.enqueue(
      makeNotificationDelivery(principalId, { outboxEventId, kind: "in_app" }),
    );
    expect(
      await ctx.repos.notificationDeliveries.existsForEvent(
        outboxEventId,
        "in_app",
        "",
      ),
    ).toBe(true);
  });

  it("contract: claimDue burns an attempt, and failure schedules the next one", async () => {
    const principalId = await seedPrincipal();
    const now = new Date();
    const authReqId = `areq_${randomUUID()}`;
    const delivery = await ctx.repos.notificationDeliveries.enqueue(
      makeNotificationDelivery(principalId, { authReqId, nextAttemptAt: now }),
    );

    const claimed = await ctx.repos.notificationDeliveries.claimDue(10, now);
    expect(claimed.map((row) => row.id)).toContain(delivery.id);
    expect(claimed.find((row) => row.id === delivery.id)?.attempts).toBe(1);

    const later = new Date(now.getTime() + 60_000);
    await ctx.repos.notificationDeliveries.recordFailure(
      delivery.id,
      "provider_rejected",
      later,
      false,
    );
    const [failed] =
      await ctx.repos.notificationDeliveries.listForRequest(authReqId);
    expect(failed?.state).toBe("failed");
    expect(failed?.lastError).toBe("provider_rejected");
    expect(failed?.nextAttemptAt).toEqual(later);

    await ctx.repos.notificationDeliveries.markDelivered(
      delivery.id,
      later,
      "slack:1700000000.0001",
    );
    const [delivered] =
      await ctx.repos.notificationDeliveries.listForRequest(authReqId);
    expect(delivered?.state).toBe("delivered");
    expect(delivered?.providerMessageRef).toBe("slack:1700000000.0001");
    expect(
      (await ctx.repos.notificationDeliveries.claimDue(10, later)).map(
        (row) => row.id,
      ),
    ).not.toContain(delivery.id);
  });
});

describe("PostgresRepositories.approvalActivations", () => {
  it("adversarial: two settlements racing on one activation, exactly one wins", async () => {
    const principalId = await seedPrincipal();
    const activation = await ctx.repos.approvalActivations.create(
      makeApprovalActivation(principalId, { state: "activated" }),
    );
    const at = new Date();

    const results = await Promise.all([
      ctx.repos.approvalActivations.consume(activation.id, at),
      ctx.repos.approvalActivations.consume(activation.id, at),
    ]);
    expect(results.filter((row) => row !== null)).toHaveLength(1);
    expect(
      (await ctx.repos.approvalActivations.getById(activation.id))?.state,
    ).toBe("consumed");
  });

  it("adversarial: an activation that was never activated cannot be spent", async () => {
    const principalId = await seedPrincipal();
    const activation = await ctx.repos.approvalActivations.create(
      makeApprovalActivation(principalId, { state: "pending" }),
    );
    expect(
      await ctx.repos.approvalActivations.consume(activation.id, new Date()),
    ).toBeNull();
  });

  it("contract: an activation is found by its challenge digest and moves under CAS", async () => {
    const principalId = await seedPrincipal();
    const challengeDigest = `sha256:${randomUUID()}`;
    const activation = await ctx.repos.approvalActivations.create(
      makeApprovalActivation(principalId, {
        state: "pending",
        challengeDigest,
      }),
    );

    const found =
      await ctx.repos.approvalActivations.findByChallengeDigest(
        challengeDigest,
      );
    expect(found?.id).toBe(activation.id);
    expect(
      await ctx.repos.approvalActivations.findByChallengeDigest(
        `sha256:${randomUUID()}`,
      ),
    ).toBeNull();

    const activated = await ctx.repos.approvalActivations.updateWithVersion(
      activation.id,
      activation.version,
      { state: "activated", activatedAt: new Date(), method: "webauthn" },
    );
    expect(activated.state).toBe("activated");
    expect(activated.version).toBe(2);
    await expect(
      ctx.repos.approvalActivations.updateWithVersion(
        activation.id,
        activation.version,
        { state: "consumed" },
      ),
    ).rejects.toBeInstanceOf(ConflictError);
  });
});

describe("PostgresRepositories.comparisonChallenges", () => {
  it("adversarial: the budget runs out and re-issuing does not refill it", async () => {
    const now = new Date();
    const authReqId = `areq_${randomUUID()}`;
    await ctx.repos.comparisonChallenges.create(
      makeComparisonChallenge({ authReqId, maxAttempts: 2 }),
    );

    expect(
      (await ctx.repos.comparisonChallenges.consumeAttempt(authReqId, now))
        ?.attempts,
    ).toBe(1);
    expect(
      (await ctx.repos.comparisonChallenges.consumeAttempt(authReqId, now))
        ?.attempts,
    ).toBe(2);
    expect(
      await ctx.repos.comparisonChallenges.consumeAttempt(authReqId, now),
    ).toBeNull();

    await expect(
      ctx.repos.comparisonChallenges.create(
        makeComparisonChallenge({ authReqId, maxAttempts: 2 }),
      ),
    ).rejects.toBeInstanceOf(ConflictError);
    expect(
      await ctx.repos.comparisonChallenges.consumeAttempt(authReqId, now),
    ).toBeNull();
    expect(
      (await ctx.repos.comparisonChallenges.getForRequest(authReqId))?.attempts,
    ).toBe(2);
  });

  it("contract: a challenge is satisfied exactly once", async () => {
    const authReqId = `areq_${randomUUID()}`;
    await ctx.repos.comparisonChallenges.create(
      makeComparisonChallenge({ authReqId }),
    );
    const at = new Date();

    expect(
      (await ctx.repos.comparisonChallenges.markSatisfied(authReqId, at))
        ?.satisfiedAt,
    ).toEqual(at);
    expect(
      await ctx.repos.comparisonChallenges.markSatisfied(authReqId, new Date()),
    ).toBeNull();
    expect(
      await ctx.repos.comparisonChallenges.consumeAttempt(
        authReqId,
        new Date(),
      ),
    ).toBeNull();
  });
});

describe("PostgresRepositories.approvalReceipts", () => {
  it("contract: one receipt per request, and it reads back whole", async () => {
    const principalId = await seedPrincipal();
    const authReqId = `areq_${randomUUID()}`;
    const receipt = await ctx.repos.approvalReceipts.create(
      makeApprovalReceipt(principalId, { authReqId }),
    );

    const stored = await ctx.repos.approvalReceipts.getForRequest(authReqId);
    expect(stored).toEqual(receipt);
    expect(stored?.requiredAssurance).toEqual(["user_verification"]);
    expect(stored?.achievedAssurance).toEqual(["user_verification"]);

    await expect(
      ctx.repos.approvalReceipts.create(
        makeApprovalReceipt(principalId, { authReqId }),
      ),
    ).rejects.toBeInstanceOf(ConflictError);
    expect(
      await ctx.repos.approvalReceipts.getForRequest(`areq_${randomUUID()}`),
    ).toBeNull();
  });
});

describe("PostgresRepositories.callbackReplays", () => {
  it("adversarial: the second claim of one callback is refused", async () => {
    const record = makeCallbackReplay();

    expect(await ctx.repos.callbackReplays.claim(record)).toBe(true);
    expect(await ctx.repos.callbackReplays.claim(record)).toBe(false);
    expect(
      await ctx.repos.callbackReplays.claim({
        ...record,
        id: `slack:${randomUUID()}`,
      }),
    ).toBe(true);
  });

  it("adversarial: concurrent claims of one callback produce exactly one winner", async () => {
    const record = makeCallbackReplay();
    const results = await Promise.all([
      ctx.repos.callbackReplays.claim(record),
      ctx.repos.callbackReplays.claim(record),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("contract: purgeExpired drops lapsed rows and frees the id", async () => {
    const now = new Date();
    const expired = makeCallbackReplay({
      expiresAt: new Date(now.getTime() - 1_000),
    });
    const live = makeCallbackReplay({
      expiresAt: new Date(now.getTime() + 60_000),
    });
    await ctx.repos.callbackReplays.claim(expired);
    await ctx.repos.callbackReplays.claim(live);

    expect(await ctx.repos.callbackReplays.purgeExpired(now)).toBe(1);
    expect(await ctx.repos.callbackReplays.claim(expired)).toBe(true);
    expect(await ctx.repos.callbackReplays.claim(live)).toBe(false);
  });
});

describe("PostgresRepositories.pushSubscriptions", () => {
  it("contract: re-subscribing with the same endpoint replaces rather than duplicates", async () => {
    const principalId = await seedPrincipal();
    const endpointDigest = `sha256:${randomUUID()}`;
    const first = await ctx.repos.pushSubscriptions.create(
      makePushSubscription(principalId, {
        endpointDigest,
        deviceLabel: "old laptop",
      }),
    );

    const second = await ctx.repos.pushSubscriptions.create(
      makePushSubscription(principalId, {
        endpointDigest,
        deviceLabel: "same laptop",
      }),
    );
    expect(second.id).toBe(first.id);
    expect(second.createdAt).toEqual(first.createdAt);
    expect(second.deviceLabel).toBe("same laptop");
    expect(second.authSecret).not.toBe(first.authSecret);

    const live =
      await ctx.repos.pushSubscriptions.listForPrincipal(principalId);
    expect(live).toHaveLength(1);
    expect(live[0]?.id).toBe(first.id);
    expect(
      (await ctx.repos.pushSubscriptions.findByEndpointDigest(endpointDigest))
        ?.id,
    ).toBe(first.id);
  });

  it("adversarial: a disabled subscription is no longer a destination", async () => {
    const principalId = await seedPrincipal();
    const sub = await ctx.repos.pushSubscriptions.create(
      makePushSubscription(principalId),
    );
    const other = await ctx.repos.pushSubscriptions.create(
      makePushSubscription(principalId),
    );
    const at = new Date();

    expect(await ctx.repos.pushSubscriptions.disable(sub.id, at)).toBe(true);
    expect(await ctx.repos.pushSubscriptions.disable(sub.id, new Date())).toBe(
      false,
    );
    expect(await ctx.repos.pushSubscriptions.disable(randomUUID(), at)).toBe(
      false,
    );

    const live =
      await ctx.repos.pushSubscriptions.listForPrincipal(principalId);
    expect(live.map((row) => row.id)).toEqual([other.id]);
    expect(
      (await ctx.repos.pushSubscriptions.getById(sub.id))?.disabledAt,
    ).toEqual(at);
  });

  it("contract: re-subscribing revives a disabled subscription", async () => {
    const principalId = await seedPrincipal();
    const endpointDigest = `sha256:${randomUUID()}`;
    const sub = await ctx.repos.pushSubscriptions.create(
      makePushSubscription(principalId, { endpointDigest }),
    );
    await ctx.repos.pushSubscriptions.disable(sub.id, new Date());
    expect(
      await ctx.repos.pushSubscriptions.listForPrincipal(principalId),
    ).toEqual([]);

    const revived = await ctx.repos.pushSubscriptions.create(
      makePushSubscription(principalId, { endpointDigest }),
    );
    expect(revived.id).toBe(sub.id);
    expect(revived.disabledAt).toBeUndefined();
    expect(
      (await ctx.repos.pushSubscriptions.listForPrincipal(principalId)).map(
        (row) => row.id,
      ),
    ).toEqual([sub.id]);
  });

  it("contract: a principal's subscriptions are their own", async () => {
    const principalId = await seedPrincipal();
    const otherId = await seedPrincipal();
    await ctx.repos.pushSubscriptions.create(makePushSubscription(principalId));
    await ctx.repos.pushSubscriptions.create(makePushSubscription(otherId));

    const mine =
      await ctx.repos.pushSubscriptions.listForPrincipal(principalId);
    expect(mine).toHaveLength(1);
    expect(mine[0]?.principalId).toBe(principalId);
  });
});
