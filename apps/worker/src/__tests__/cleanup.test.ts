import { ClaimEngine, MemoryClaimStore } from "@opensesame/claims";
import { createRepositories } from "@opensesame/database";
import { fixtures } from "@opensesame/os-domain";
import type { Project } from "@opensesame/os-domain";
import { describe, expect, it } from "vitest";
import {
  EXPIRED_PROJECT_RETENTION_MS,
  createFakeClock,
  runCleanupTick,
  startCleanupLoop,
} from "../cleanup.js";

describe("cleanup worker", () => {
  it("expires claim via fake clock", async () => {
    const store = new MemoryClaimStore();
    const ids: string[] = [];
    const listStore = { listIds: () => ids };
    const clock = createFakeClock(fixtures.now);
    const claims = new ClaimEngine({
      pepper: fixtures.pepper,
      store,
      clock: clock.asClock(),
    });

    const created = await claims.createClaim({
      type: "project",
      targetManifest: { x: 1 },
      ttlMs: 1_000,
    });
    ids.push(created.session.id);

    expect((await claims.get(created.session.id))?.state).toBe("pending");

    clock.advance(2_000);
    const result = await runCleanupTick({
      claims,
      claimStore: listStore,
      repos: createRepositories(),
      provisionalSessions: new Map(),
      projects: new Map(),
      clock: clock.asClock(),
    });

    expect(result.expiredClaims).toBe(1);
    expect((await claims.get(created.session.id))?.state).toBe("expired");
  });

  it("prunes the issuer's expired rows and keeps going if that fails", async () => {
    const clock = createFakeClock(fixtures.now);
    const calls: Date[] = [];

    const pruned = await runCleanupTick({
      repos: createRepositories(),
      clock: clock.asClock(),
      oidcStore: {
        pruneExpired: async (now = new Date()) => {
          calls.push(now);
          return 3;
        },
      },
    });
    expect(pruned.prunedOidcRows).toBe(3);
    // Pruned against the tick's clock, not wall time: a fake clock has to reach
    // the store or the TTL under test is not the one being applied.
    expect(calls[0]?.getTime()).toBe(fixtures.now.getTime());

    // A store that throws must not cost us the outbox. Reads already refuse an
    // expired row, so a failed prune is a table that stays large, not a token
    // that is honoured late.
    const survived = await runCleanupTick({
      repos: createRepositories(),
      clock: clock.asClock(),
      oidcStore: {
        pruneExpired: async () => {
          throw new Error("connection reset");
        },
      },
    });
    expect(survived.prunedOidcRows).toBeUndefined();
    expect(survived.outboxPublished).toBe(0);

    // No store at all is not the same as nothing to prune.
    const absent = await runCleanupTick({
      repos: createRepositories(),
      clock: clock.asClock(),
    });
    expect(absent.prunedOidcRows).toBeUndefined();
  });

  it("expires an activated temporary project and reaps it later", async () => {
    const clock = createFakeClock(fixtures.now);
    const project: Project = {
      id: "proj_1",
      ownerPrincipalId: "prn_1",
      slug: "temp",
      displayName: "Temp",
      // Activated, not provisional — this is the case that used to be skipped.
      state: "active",
      expiresAt: new Date(fixtures.now.getTime() + 1_000),
      createdAt: fixtures.now,
      updatedAt: fixtures.now,
    };
    const projects = new Map([[project.id, project]]);
    const deps = {
      claims: new ClaimEngine({
        pepper: fixtures.pepper,
        store: new MemoryClaimStore(),
        clock: clock.asClock(),
      }),
      claimStore: { listIds: () => [] },
      repos: createRepositories(),
      provisionalSessions: new Map(),
      projects,
      clock: clock.asClock(),
    };

    clock.advance(2_000);
    const expired = await runCleanupTick(deps);
    expect(expired.expiredProjects).toBe(1);
    expect(projects.get(project.id)?.state).toBe("expired");

    // Kept briefly for inspection, then dropped so the map cannot grow forever.
    const stillThere = await runCleanupTick(deps);
    expect(stillThere.reapedProjects).toBe(0);
    clock.advance(EXPIRED_PROJECT_RETENTION_MS + 1);
    const reaped = await runCleanupTick(deps);
    expect(reaped.reapedProjects).toBe(1);
    expect(projects.size).toBe(0);
  });

  it("says when a tick had no state to expire", async () => {
    const clock = createFakeClock(fixtures.now);
    // The standalone shape: no claim engine, no session or project maps.
    const result = await runCleanupTick({
      repos: createRepositories(),
      clock: clock.asClock(),
    });
    // Zero counts because nothing was inspected, and the tick admits it rather
    // than reading as "nothing had lapsed".
    expect(result.expiryEnforced).toBe(false);
    expect(result.expiredClaims).toBe(0);
    expect(result.expiredProjects).toBe(0);

    const inProcess = await runCleanupTick({
      claims: new ClaimEngine({
        pepper: fixtures.pepper,
        store: new MemoryClaimStore(),
        clock: clock.asClock(),
      }),
      claimStore: { listIds: () => [] },
      repos: createRepositories(),
      provisionalSessions: new Map(),
      projects: new Map(),
      clock: clock.asClock(),
    });
    expect(inProcess.expiryEnforced).toBe(true);
  });

  it("keeps expiring after a failing tick", async () => {
    const clock = createFakeClock(fixtures.now);
    let calls = 0;
    const controller = new AbortController();
    const claimStore = {
      listIds: () => {
        calls += 1;
        if (calls === 1) throw new Error("store unavailable");
        if (calls >= 3) controller.abort();
        return [];
      },
    };
    const errors: string[] = [];

    await startCleanupLoop({
      claims: new ClaimEngine({
        pepper: fixtures.pepper,
        store: new MemoryClaimStore(),
        clock: clock.asClock(),
      }),
      claimStore,
      repos: createRepositories(),
      provisionalSessions: new Map(),
      projects: new Map(),
      clock: clock.asClock(),
      intervalMs: 0,
      signal: controller.signal,
      log: {
        error: (_obj: unknown, msg: string) => errors.push(msg),
      } as never,
    });

    // The throwing first tick did not end the loop.
    expect(calls).toBeGreaterThanOrEqual(3);
    expect(errors[0]).toContain("cleanup tick failed");
  });
});
