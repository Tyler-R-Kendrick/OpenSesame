import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ConflictError, MemoryRepositories } from "../src/index.js";
import {
  makeApprovalActivation,
  makeApprovalReceipt,
  makeBindingChallenge,
  makeCallbackReplay,
  makeChannelBinding,
  makeComparisonChallenge,
  makeNotificationDelivery,
  makeNotificationPreferences,
  makePrincipal,
  makePushSubscription,
} from "./factories.js";

/**
 * The memory half of the ADR 0081 parity suite. Every assertion here has a
 * mirror in `postgres-repos.test.ts`: a rule the two stores disagree about is
 * a rule neither of them really has, and the disagreements that matter are all
 * the ones a second replica would exploit.
 */
async function seed() {
  const repos = new MemoryRepositories();
  const principal = await repos.principals.create(makePrincipal());
  return { repos, principalId: principal.id };
}

describe("MemoryRepositories.channelBindings", () => {
  it("adversarial: a matching subject in the wrong tenant resolves to nothing", async () => {
    const { repos, principalId } = await seed();
    const binding = await repos.channelBindings.create(
      makeChannelBinding(principalId, {
        providerTenantId: "T_ACME",
        providerSubjectId: "U_ALICE",
      }),
    );

    // The whole point of keying on the tenant: subject ids are unique within a
    // workspace, so anyone who can create a workspace can name "U_ALICE".
    expect(
      await repos.channelBindings.findByProviderIdentity(
        "slack",
        "slack",
        "T_EVIL",
        "U_ALICE",
      ),
    ).toBeNull();
    expect(
      await repos.channelBindings.findByProviderIdentity(
        "slack",
        "slack",
        "T_ACME",
        "U_MALLORY",
      ),
    ).toBeNull();
    expect(
      await repos.channelBindings.findByProviderIdentity(
        "telegram",
        "slack",
        "T_ACME",
        "U_ALICE",
      ),
    ).toBeNull();
    const found = await repos.channelBindings.findByProviderIdentity(
      "slack",
      "slack",
      "T_ACME",
      "U_ALICE",
    );
    expect(found?.id).toBe(binding.id);
  });

  it("adversarial: an empty subject matches nothing", async () => {
    const { repos, principalId } = await seed();
    await repos.channelBindings.create(
      makeChannelBinding(principalId, {
        providerTenantId: "T_ACME",
        providerSubjectId: "U_ALICE",
      }),
    );
    expect(
      await repos.channelBindings.findByProviderIdentity(
        "slack",
        "slack",
        "T_ACME",
        "",
      ),
    ).toBeNull();
  });

  it("adversarial: an empty subject cannot even be stored", async () => {
    const { repos, principalId } = await seed();
    // The memory guard mirrors `channel_bindings_provider_subject_id_check`.
    await expect(
      repos.channelBindings.create(
        makeChannelBinding(principalId, { providerSubjectId: "" }),
      ),
    ).rejects.toBeInstanceOf(Error);
  });

  it("adversarial: the same provider identity cannot be bound twice", async () => {
    const { repos, principalId } = await seed();
    const first = makeChannelBinding(principalId, {
      providerTenantId: "T_ACME",
      providerSubjectId: "U_ALICE",
    });
    await repos.channelBindings.create(first);
    await expect(
      repos.channelBindings.create(
        makeChannelBinding(principalId, {
          providerTenantId: "T_ACME",
          providerSubjectId: "U_ALICE",
        }),
      ),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it("property: updateWithVersion with a stale version always conflicts", async () => {
    const { repos, principalId } = await seed();
    const created = await repos.channelBindings.create(
      makeChannelBinding(principalId),
    );
    for (const stale of [0, 2, 5, 99]) {
      await expect(
        repos.channelBindings.updateWithVersion(created.id, stale, {
          state: "revoked",
        }),
      ).rejects.toBeInstanceOf(ConflictError);
    }
    const revoked = await repos.channelBindings.updateWithVersion(
      created.id,
      created.version,
      { state: "revoked", revokedAt: new Date() },
    );
    expect(revoked.version).toBe(2);
    expect(revoked.state).toBe("revoked");
  });

  it("chaos: a stored binding is a copy, so mutating it cannot rewrite the row", async () => {
    const { repos, principalId } = await seed();
    const created = await repos.channelBindings.create(
      makeChannelBinding(principalId),
    );
    created.state = "revoked";
    created.displayLabel = "smuggled";
    created.metadata.smuggled = "yes";

    const fresh = await repos.channelBindings.getById(created.id);
    expect(fresh?.state).toBe("active");
    expect(fresh?.displayLabel).toBeUndefined();
    expect(fresh?.metadata).toEqual({});
  });

  it("contract: a principal's bindings list is their own", async () => {
    const { repos, principalId } = await seed();
    const other = await repos.principals.create(makePrincipal());
    await repos.channelBindings.create(makeChannelBinding(principalId));
    await repos.channelBindings.create(makeChannelBinding(other.id));

    const listed = await repos.channelBindings.listForPrincipal(principalId);
    expect(listed).toHaveLength(1);
    expect(listed[0]?.principalId).toBe(principalId);
  });
});

describe("MemoryRepositories.channelBindingChallenges", () => {
  it("adversarial: completing a challenge twice only works once", async () => {
    const { repos, principalId } = await seed();
    const challenge = await repos.channelBindingChallenges.create(
      makeBindingChallenge(principalId),
    );
    const at = new Date();

    const won = await repos.channelBindingChallenges.complete(challenge.id, at);
    expect(won?.completedAt).toEqual(at);
    expect(
      await repos.channelBindingChallenges.complete(challenge.id, new Date()),
    ).toBeNull();
  });

  it("contract: the attempt budget is spent durably and then refused", async () => {
    const { repos, principalId } = await seed();
    const now = new Date();
    const challenge = await repos.channelBindingChallenges.create(
      makeBindingChallenge(principalId, { maxAttempts: 2 }),
    );

    expect(
      (await repos.channelBindingChallenges.consumeAttempt(challenge.id, now))
        ?.attempts,
    ).toBe(1);
    expect(
      (await repos.channelBindingChallenges.consumeAttempt(challenge.id, now))
        ?.attempts,
    ).toBe(2);
    expect(
      await repos.channelBindingChallenges.consumeAttempt(challenge.id, now),
    ).toBeNull();
    expect(
      (await repos.channelBindingChallenges.getById(challenge.id))?.attempts,
    ).toBe(2);
  });

  it("contract: an expired challenge spends nothing", async () => {
    const { repos, principalId } = await seed();
    const now = new Date();
    const challenge = await repos.channelBindingChallenges.create(
      makeBindingChallenge(principalId, {
        expiresAt: new Date(now.getTime() - 1_000),
      }),
    );
    expect(
      await repos.channelBindingChallenges.consumeAttempt(challenge.id, now),
    ).toBeNull();
  });
});

describe("MemoryRepositories.notificationPreferences", () => {
  it("contract: preferences round-trip and upsert replaces in place", async () => {
    const { repos, principalId } = await seed();
    expect(await repos.notificationPreferences.get(principalId)).toBeNull();

    await repos.notificationPreferences.upsert(
      makeNotificationPreferences(principalId),
    );
    const stored = await repos.notificationPreferences.get(principalId);
    expect(stored?.byClass).toEqual({
      authorization_request: { channels: ["in_app"], fanOut: false },
    });

    await repos.notificationPreferences.upsert(
      makeNotificationPreferences(principalId, {
        byClass: {
          security_event: { channels: ["in_app", "slack"], fanOut: true },
        },
        version: 2,
      }),
    );
    const updated = await repos.notificationPreferences.get(principalId);
    expect(updated?.version).toBe(2);
    expect(updated?.byClass).toEqual({
      security_event: { channels: ["in_app", "slack"], fanOut: true },
    });
  });
});

describe("MemoryRepositories.notificationDeliveries", () => {
  it("contract: existsForEvent is true after enqueue and a duplicate fan-out conflicts", async () => {
    const { repos, principalId } = await seed();
    const outboxEventId = randomUUID();
    const bindingId = `chb_${randomUUID()}`;
    await repos.notificationDeliveries.enqueue(
      makeNotificationDelivery(principalId, { outboxEventId, bindingId }),
    );

    expect(
      await repos.notificationDeliveries.existsForEvent(
        outboxEventId,
        "slack",
        bindingId,
      ),
    ).toBe(true);
    expect(
      await repos.notificationDeliveries.existsForEvent(
        outboxEventId,
        "slack",
        `chb_${randomUUID()}`,
      ),
    ).toBe(false);
    expect(
      await repos.notificationDeliveries.existsForEvent(
        outboxEventId,
        "telegram",
        bindingId,
      ),
    ).toBe(false);

    // The outbox is at-least-once, so the retried drain must collide.
    await expect(
      repos.notificationDeliveries.enqueue(
        makeNotificationDelivery(principalId, { outboxEventId, bindingId }),
      ),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it("contract: a destination-less delivery still keys on the empty string", async () => {
    const { repos, principalId } = await seed();
    const outboxEventId = randomUUID();
    await repos.notificationDeliveries.enqueue(
      makeNotificationDelivery(principalId, { outboxEventId, kind: "in_app" }),
    );
    expect(
      await repos.notificationDeliveries.existsForEvent(
        outboxEventId,
        "in_app",
        "",
      ),
    ).toBe(true);
  });

  it("contract: claimDue burns an attempt, and failure schedules the next one", async () => {
    const { repos, principalId } = await seed();
    const now = new Date();
    const authReqId = `areq_${randomUUID()}`;
    const delivery = await repos.notificationDeliveries.enqueue(
      makeNotificationDelivery(principalId, { authReqId, nextAttemptAt: now }),
    );

    const claimed = await repos.notificationDeliveries.claimDue(10, now);
    expect(claimed.map((row) => row.id)).toContain(delivery.id);
    expect(claimed.find((row) => row.id === delivery.id)?.attempts).toBe(1);

    const later = new Date(now.getTime() + 60_000);
    await repos.notificationDeliveries.recordFailure(
      delivery.id,
      "provider_rejected",
      later,
      false,
    );
    const [failed] =
      await repos.notificationDeliveries.listForRequest(authReqId);
    expect(failed?.state).toBe("failed");
    expect(failed?.lastError).toBe("provider_rejected");
    expect(failed?.nextAttemptAt).toEqual(later);

    await repos.notificationDeliveries.markDelivered(
      delivery.id,
      later,
      "slack:1700000000.0001",
    );
    const [delivered] =
      await repos.notificationDeliveries.listForRequest(authReqId);
    expect(delivered?.state).toBe("delivered");
    expect(delivered?.providerMessageRef).toBe("slack:1700000000.0001");
    // A delivered row is no longer due, whatever its next-attempt stamp says.
    expect(
      (await repos.notificationDeliveries.claimDue(10, later)).map(
        (row) => row.id,
      ),
    ).not.toContain(delivery.id);
  });
});

describe("MemoryRepositories.approvalActivations", () => {
  it("adversarial: two settlements racing on one activation, exactly one wins", async () => {
    const { repos, principalId } = await seed();
    const activation = await repos.approvalActivations.create(
      makeApprovalActivation(principalId, { state: "activated" }),
    );
    const at = new Date();

    const results = await Promise.all([
      repos.approvalActivations.consume(activation.id, at),
      repos.approvalActivations.consume(activation.id, at),
    ]);
    expect(results.filter((row) => row !== null)).toHaveLength(1);
    expect(
      (await repos.approvalActivations.getById(activation.id))?.state,
    ).toBe("consumed");
  });

  it("adversarial: an activation that was never activated cannot be spent", async () => {
    const { repos, principalId } = await seed();
    const activation = await repos.approvalActivations.create(
      makeApprovalActivation(principalId, { state: "pending" }),
    );
    expect(
      await repos.approvalActivations.consume(activation.id, new Date()),
    ).toBeNull();
  });

  it("contract: an activation is found by its challenge digest and moves under CAS", async () => {
    const { repos, principalId } = await seed();
    const challengeDigest = `sha256:${randomUUID()}`;
    const activation = await repos.approvalActivations.create(
      makeApprovalActivation(principalId, {
        state: "pending",
        challengeDigest,
      }),
    );

    const found =
      await repos.approvalActivations.findByChallengeDigest(challengeDigest);
    expect(found?.id).toBe(activation.id);
    expect(
      await repos.approvalActivations.findByChallengeDigest(
        `sha256:${randomUUID()}`,
      ),
    ).toBeNull();

    const activated = await repos.approvalActivations.updateWithVersion(
      activation.id,
      activation.version,
      { state: "activated", activatedAt: new Date(), method: "webauthn" },
    );
    expect(activated.state).toBe("activated");
    expect(activated.version).toBe(2);
    await expect(
      repos.approvalActivations.updateWithVersion(
        activation.id,
        activation.version,
        { state: "consumed" },
      ),
    ).rejects.toBeInstanceOf(ConflictError);
  });
});

describe("MemoryRepositories.comparisonChallenges", () => {
  it("adversarial: the budget runs out and re-issuing does not refill it", async () => {
    const { repos } = await seed();
    const now = new Date();
    const authReqId = `areq_${randomUUID()}`;
    await repos.comparisonChallenges.create(
      makeComparisonChallenge({ authReqId, maxAttempts: 2 }),
    );

    expect(
      (await repos.comparisonChallenges.consumeAttempt(authReqId, now))
        ?.attempts,
    ).toBe(1);
    expect(
      (await repos.comparisonChallenges.consumeAttempt(authReqId, now))
        ?.attempts,
    ).toBe(2);
    expect(
      await repos.comparisonChallenges.consumeAttempt(authReqId, now),
    ).toBeNull();

    // A second POST must not hand back a fresh set of guesses at six digits.
    await expect(
      repos.comparisonChallenges.create(
        makeComparisonChallenge({ authReqId, maxAttempts: 2 }),
      ),
    ).rejects.toBeInstanceOf(ConflictError);
    expect(
      await repos.comparisonChallenges.consumeAttempt(authReqId, now),
    ).toBeNull();
    expect(
      (await repos.comparisonChallenges.getForRequest(authReqId))?.attempts,
    ).toBe(2);
  });

  it("contract: a challenge is satisfied exactly once", async () => {
    const { repos } = await seed();
    const authReqId = `areq_${randomUUID()}`;
    await repos.comparisonChallenges.create(
      makeComparisonChallenge({ authReqId }),
    );
    const at = new Date();

    expect(
      (await repos.comparisonChallenges.markSatisfied(authReqId, at))
        ?.satisfiedAt,
    ).toEqual(at);
    expect(
      await repos.comparisonChallenges.markSatisfied(authReqId, new Date()),
    ).toBeNull();
    // And a satisfied challenge stops accepting guesses.
    expect(
      await repos.comparisonChallenges.consumeAttempt(authReqId, new Date()),
    ).toBeNull();
  });
});

describe("MemoryRepositories.approvalReceipts", () => {
  it("contract: one receipt per request, and it reads back whole", async () => {
    const { repos, principalId } = await seed();
    const authReqId = `areq_${randomUUID()}`;
    const receipt = await repos.approvalReceipts.create(
      makeApprovalReceipt(principalId, { authReqId }),
    );

    const stored = await repos.approvalReceipts.getForRequest(authReqId);
    expect(stored).toEqual(receipt);
    // Both bars are kept, so a later policy change cannot re-characterise it.
    expect(stored?.requiredAssurance).toEqual(["user_verification"]);
    expect(stored?.achievedAssurance).toEqual(["user_verification"]);

    await expect(
      repos.approvalReceipts.create(
        makeApprovalReceipt(principalId, { authReqId }),
      ),
    ).rejects.toBeInstanceOf(ConflictError);
    expect(
      await repos.approvalReceipts.getForRequest(`areq_${randomUUID()}`),
    ).toBeNull();
  });
});

describe("MemoryRepositories.callbackReplays", () => {
  it("adversarial: the second claim of one callback is refused", async () => {
    const { repos } = await seed();
    const record = makeCallbackReplay();

    expect(await repos.callbackReplays.claim(record)).toBe(true);
    // The replayed callback — same provider, same digest, same id.
    expect(await repos.callbackReplays.claim(record)).toBe(false);
    expect(
      await repos.callbackReplays.claim({
        ...record,
        id: `slack:${randomUUID()}`,
      }),
    ).toBe(true);
  });

  it("adversarial: concurrent claims of one callback produce exactly one winner", async () => {
    const { repos } = await seed();
    const record = makeCallbackReplay();
    const results = await Promise.all([
      repos.callbackReplays.claim(record),
      repos.callbackReplays.claim(record),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("contract: purgeExpired drops lapsed rows and frees the id", async () => {
    const { repos } = await seed();
    const now = new Date();
    const expired = makeCallbackReplay({
      expiresAt: new Date(now.getTime() - 1_000),
    });
    const live = makeCallbackReplay({
      expiresAt: new Date(now.getTime() + 60_000),
    });
    await repos.callbackReplays.claim(expired);
    await repos.callbackReplays.claim(live);

    expect(await repos.callbackReplays.purgeExpired(now)).toBe(1);
    expect(await repos.callbackReplays.claim(expired)).toBe(true);
    expect(await repos.callbackReplays.claim(live)).toBe(false);
  });
});

describe("MemoryRepositories.pushSubscriptions", () => {
  it("contract: re-subscribing with the same endpoint replaces rather than duplicates", async () => {
    const { repos, principalId } = await seed();
    const endpointDigest = `sha256:${randomUUID()}`;
    const first = await repos.pushSubscriptions.create(
      makePushSubscription(principalId, {
        endpointDigest,
        deviceLabel: "old laptop",
      }),
    );

    // The browser re-subscribes: same endpoint, fresh keys, a new candidate id.
    const second = await repos.pushSubscriptions.create(
      makePushSubscription(principalId, {
        endpointDigest,
        deviceLabel: "same laptop",
      }),
    );
    expect(second.id).toBe(first.id);
    expect(second.createdAt).toEqual(first.createdAt);
    expect(second.deviceLabel).toBe("same laptop");
    expect(second.authSecret).not.toBe(first.authSecret);

    const live = await repos.pushSubscriptions.listForPrincipal(principalId);
    expect(live).toHaveLength(1);
    expect(live[0]?.id).toBe(first.id);
    expect(
      (await repos.pushSubscriptions.findByEndpointDigest(endpointDigest))?.id,
    ).toBe(first.id);
  });

  it("adversarial: a disabled subscription is no longer a destination", async () => {
    const { repos, principalId } = await seed();
    const sub = await repos.pushSubscriptions.create(
      makePushSubscription(principalId),
    );
    const other = await repos.pushSubscriptions.create(
      makePushSubscription(principalId),
    );
    const at = new Date();

    expect(await repos.pushSubscriptions.disable(sub.id, at)).toBe(true);
    // Disabling is a compare-and-set: only the caller that retired it is told.
    expect(await repos.pushSubscriptions.disable(sub.id, new Date())).toBe(
      false,
    );
    expect(await repos.pushSubscriptions.disable(randomUUID(), at)).toBe(false);

    const live = await repos.pushSubscriptions.listForPrincipal(principalId);
    expect(live.map((row) => row.id)).toEqual([other.id]);
    // Still readable by id — the row is retired, not erased.
    expect((await repos.pushSubscriptions.getById(sub.id))?.disabledAt).toEqual(
      at,
    );
  });

  it("contract: re-subscribing revives a disabled subscription", async () => {
    const { repos, principalId } = await seed();
    const endpointDigest = `sha256:${randomUUID()}`;
    const sub = await repos.pushSubscriptions.create(
      makePushSubscription(principalId, { endpointDigest }),
    );
    await repos.pushSubscriptions.disable(sub.id, new Date());
    expect(await repos.pushSubscriptions.listForPrincipal(principalId)).toEqual(
      [],
    );

    const revived = await repos.pushSubscriptions.create(
      makePushSubscription(principalId, { endpointDigest }),
    );
    expect(revived.id).toBe(sub.id);
    expect(revived.disabledAt).toBeUndefined();
    expect(
      (await repos.pushSubscriptions.listForPrincipal(principalId)).map(
        (row) => row.id,
      ),
    ).toEqual([sub.id]);
  });

  it("contract: a principal's subscriptions are their own", async () => {
    const { repos, principalId } = await seed();
    const other = await repos.principals.create(makePrincipal());
    await repos.pushSubscriptions.create(makePushSubscription(principalId));
    await repos.pushSubscriptions.create(makePushSubscription(other.id));

    const mine = await repos.pushSubscriptions.listForPrincipal(principalId);
    expect(mine).toHaveLength(1);
    expect(mine[0]?.principalId).toBe(principalId);
  });
});
