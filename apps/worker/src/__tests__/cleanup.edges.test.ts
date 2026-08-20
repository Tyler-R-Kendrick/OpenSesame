import { ClaimEngine, MemoryClaimStore } from "@opensesame/claims";
import { createRepositories } from "@opensesame/database";
import { fixtures, overlapCast, type BoundaryValue } from "@opensesame/os-domain";
import type { Project, ProvisionalSession } from "@opensesame/os-domain";
import { describe, expect, it } from "vitest";
import {
  EXPIRED_PROJECT_RETENTION_MS,
  createFakeClock,
  runCleanupTick,
} from "../cleanup.js";

function provisionalSession(
  id: string,
  overrides: Partial<ProvisionalSession> = {},
): ProvisionalSession {
  return {
    id,
    principalId: "prn_1",
    quotaProfile: "default",
    allowedActions: [],
    createdAt: fixtures.now,
    expiresAt: new Date(fixtures.now.getTime() + 60_000),
    ...overrides,
  };
}

describe("createFakeClock", () => {
  it("reads, sets and advances the wall clock", () => {
    const clock = createFakeClock(fixtures.now);
    expect(clock.now.getTime()).toBe(fixtures.now.getTime());

    clock.advance(1_500);
    expect(clock.now.getTime()).toBe(fixtures.now.getTime() + 1_500);

    const later = new Date(fixtures.now.getTime() + 10_000);
    clock.now = later;
    expect(clock.now.getTime()).toBe(later.getTime());
    expect(clock.asClock()().getTime()).toBe(later.getTime());
  });
});

describe("cleanup tick — claim edge cases", () => {
  it("expires a claim through the engine when the engine clock lags behind", async () => {
    // The worker's tick clock has moved past the TTL while the engine's own
    // clock has not: `get` reports pending, so the tick drives `expire` itself
    // instead of counting an expiry the engine already persisted.
    const engineClock = createFakeClock(fixtures.now);
    const tickClock = createFakeClock(fixtures.now);
    const claims = new ClaimEngine({
      pepper: fixtures.pepper,
      store: new MemoryClaimStore(),
      clock: engineClock.asClock(),
    });
    const created = await claims.createClaim({
      type: "project",
      targetManifest: { x: 1 },
      ttlMs: 1_000,
    });
    const ids = [created.session.id];

    tickClock.advance(2_000);
    const result = await runCleanupTick({
      claims,
      claimStore: { listIds: () => ids },
      repos: createRepositories(),
      provisionalSessions: new Map(),
      projects: new Map(),
      clock: tickClock.asClock(),
    });

    expect(result.expiredClaims).toBe(1);
    expect((await claims.get(created.session.id))?.state).toBe("expired");
  });

  it("skips terminal claims and unknown ids", async () => {
    const clock = createFakeClock(fixtures.now);
    const claims = new ClaimEngine({
      pepper: fixtures.pepper,
      store: new MemoryClaimStore(),
      clock: clock.asClock(),
    });
    const revoked = await claims.createClaim({
      type: "project",
      targetManifest: { x: 1 },
      ttlMs: 60_000,
    });
    await claims.revoke(revoked.session.id);
    const ids = [revoked.session.id, "claim_that_does_not_exist"];

    const result = await runCleanupTick({
      claims,
      claimStore: { listIds: () => ids },
      repos: createRepositories(),
      provisionalSessions: new Map(),
      projects: new Map(),
      clock: clock.asClock(),
    });

    expect(result.expiredClaims).toBe(0);
    expect((await claims.get(revoked.session.id))?.state).toBe("revoked");
  });

  it("stops iterating when the store lists ids but no engine is wired", async () => {
    const clock = createFakeClock(fixtures.now);
    let listed = 0;
    const result = await runCleanupTick({
      claimStore: {
        listIds: () => {
          listed += 1;
          return ["claim_1"];
        },
      },
      repos: createRepositories(),
      clock: clock.asClock(),
    });

    expect(listed).toBe(1);
    expect(result.expiredClaims).toBe(0);
    expect(result.expiryEnforced).toBe(false);
  });

  it("does not count a claim whose expiry never landed in the store", async () => {
    const clock = createFakeClock(fixtures.now);
    const pending = {
      id: "claim_x",
      state: "pending",
      expiresAt: new Date(fixtures.now.getTime() - 1),
    };
    const claims = {
      get: async () => pending,
      expire: async () => {
        throw new Error("cas lost");
      },
    };

    const result = await runCleanupTick({
      claims: overlapCast(claims),
      claimStore: { listIds: () => ["claim_x"] },
      repos: createRepositories(),
      provisionalSessions: new Map(),
      projects: new Map(),
      clock: clock.asClock(),
    });

    // expire() failed and the store still shows pending: nothing to count.
    expect(result.expiredClaims).toBe(0);
  });
});

describe("cleanup tick — session and project edge cases", () => {
  it("drops lapsed and revoked provisional sessions, keeps live ones", async () => {
    const clock = createFakeClock(fixtures.now);
    const sessions = new Map<string, ProvisionalSession>([
      [
        "ses_lapsed",
        provisionalSession("ses_lapsed", {
          expiresAt: new Date(fixtures.now.getTime() - 1),
        }),
      ],
      [
        "ses_revoked",
        provisionalSession("ses_revoked", { revokedAt: fixtures.now }),
      ],
      ["ses_live", provisionalSession("ses_live")],
    ]);

    const result = await runCleanupTick({
      repos: createRepositories(),
      provisionalSessions: sessions,
      clock: clock.asClock(),
    });

    expect(result.expiredSessions).toBe(2);
    expect([...sessions.keys()]).toEqual(["ses_live"]);
  });

  it("keeps projects without a TTL and reaps deleted projects after retention", async () => {
    const clock = createFakeClock(fixtures.now);
    const noTtl: Project = {
      id: "proj_no_ttl",
      kind: "temporary",
      ownerPrincipalId: "prn_1",
      slug: "no-ttl",
      displayName: "No TTL",
      state: "active",
      createdAt: fixtures.now,
      updatedAt: fixtures.now,
    };
    const deleted: Project = {
      ...noTtl,
      id: "proj_deleted",
      slug: "deleted",
      state: "deleted",
    };
    const projects = new Map([
      [noTtl.id, noTtl],
      [deleted.id, deleted],
    ]);
    const deps = {
      repos: createRepositories(),
      projects,
      clock: clock.asClock(),
    };

    const first = await runCleanupTick(deps);
    expect(first.expiredProjects).toBe(0);
    expect(first.reapedProjects).toBe(0);
    expect(projects.get(noTtl.id)?.state).toBe("active");

    clock.advance(EXPIRED_PROJECT_RETENTION_MS);
    const second = await runCleanupTick(deps);
    expect(second.reapedProjects).toBe(1);
    expect(projects.has(deleted.id)).toBe(false);
    // No expiry means no reap: the permanent project survives retention too.
    expect(projects.has(noTtl.id)).toBe(true);
  });
});

describe("cleanup tick — issuer pruning and outbox edge cases", () => {
  it("reports a prune that removed zero rows as zero, not as absent", async () => {
    const clock = createFakeClock(fixtures.now);
    const result = await runCleanupTick({
      repos: createRepositories(),
      clock: clock.asClock(),
      oidcStore: { pruneExpired: async () => 0 },
    });
    expect(result.prunedOidcRows).toBe(0);
  });

  it("stringifies non-Error prune failures for the log", async () => {
    const clock = createFakeClock(fixtures.now);
    const errors: unknown[] = [];
    const failure = "prune blew up";
    const result = await runCleanupTick({
      repos: createRepositories(),
      clock: clock.asClock(),
      oidcStore: {
        pruneExpired: async () => {
          throw failure;
        },
      },
      log: overlapCast({
        info: () => {},
        error: (obj: BoundaryValue) => errors.push(obj),
      }),
    });

    expect(result.prunedOidcRows).toBeUndefined();
    expect(errors[0]).toMatchObject({ err: "prune blew up" });
  });

  it("releases the outbox claim with a stringified non-Error publish failure", async () => {
    const clock = createFakeClock(fixtures.now);
    const repos = createRepositories();
    await repos.outbox.append({
      id: "outbox_non_error",
      aggregateType: "principal",
      aggregateId: "prn_1",
      eventType: "principal.created",
      payload: {},
      availableAt: fixtures.now,
    });
    const failure = "socket hung up";
    const result = await runCleanupTick({
      repos,
      clock: clock.asClock(),
      taskBus: {
        publish: async () => {
          throw failure;
        },
      },
    });

    expect(result.outboxPublished).toBe(0);
    expect(await repos.outbox.listUnpublished()).toHaveLength(1);
  });
});
