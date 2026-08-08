import { describe, expect, it } from "vitest";
import { ClaimEngine, MemoryClaimStore } from "@opensesame/claims";
import { createRepositories } from "@opensesame/database";
import { fixtures } from "@opensesame/os-domain";
import { createFakeClock, runCleanupTick, startCleanupLoop } from "../cleanup.js";

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
