import {
  type ClaimSession,
  DomainError,
  fixtures,
} from "@opensesame/os-domain";
import { describe, expect, it } from "vitest";
import { ClaimEngine, MemoryClaimStore } from "../index.js";

function engine(clock?: () => Date) {
  return new ClaimEngine({
    pepper: fixtures.pepper,
    store: new MemoryClaimStore(),
    ...(clock ? { clock } : undefined),
  });
}

function bundleInput(claimId: string) {
  return {
    type: "resource_bundle" as const,
    targetManifest: { targets: [{ id: "prj_temp_001" }] },
    items: fixtures.claimItems(claimId),
  };
}

async function advanceToAuthenticated(eng: ClaimEngine) {
  const created = await eng.createClaim(bundleInput("placeholder"));
  await eng.presentClaim(created.session.id, created.token);
  await eng.authenticateClaim(created.session.id);
  return created;
}

async function advanceToReviewed(eng: ClaimEngine) {
  const created = await advanceToAuthenticated(eng);
  await eng.reviewClaim(created.session.id, {
    acceptedItemIds: ["ci_project", "ci_resource"],
  });
  return created;
}

/** Store whose CAS never wins, to drive the bounded retry loop to exhaustion. */
class LosingStore extends MemoryClaimStore {
  override async compareAndSwap(
    id: string,
    _expectedVersion: number,
    _next: ClaimSession,
  ): Promise<{ session: ClaimSession; won: boolean }> {
    const session = await this.get(id);
    if (!session) {
      throw new DomainError("NOT_FOUND", "Claim not found", { id });
    }
    return { session, won: false };
  }
}

/**
 * Simulates a concurrent reviewer persisting the same review just before our
 * swap lands: the write happens, but this caller is told it lost.
 */
class ConcurrentReviewerStore extends MemoryClaimStore {
  private injected = false;

  override async compareAndSwap(
    id: string,
    expectedVersion: number,
    next: ClaimSession,
  ): Promise<{ session: ClaimSession; won: boolean }> {
    if (!this.injected && next.state === "reviewed") {
      this.injected = true;
      const result = await super.compareAndSwap(id, expectedVersion, next);
      return { session: result.session, won: false };
    }
    return super.compareAndSwap(id, expectedVersion, next);
  }
}

/**
 * Simulates a concurrent completer with the identical decision winning the
 * completion swap: the write happens, but this caller is told it lost.
 */
class ConcurrentCompleterStore extends MemoryClaimStore {
  private injected = false;

  override async compareAndSwap(
    id: string,
    expectedVersion: number,
    next: ClaimSession,
  ): Promise<{ session: ClaimSession; won: boolean }> {
    if (!this.injected && next.state === "completed") {
      this.injected = true;
      const result = await super.compareAndSwap(id, expectedVersion, next);
      return { session: result.session, won: false };
    }
    return super.compareAndSwap(id, expectedVersion, next);
  }
}

/** Simulates a concurrent deny winning the swap our completion was racing. */
class ConcurrentDenierStore extends MemoryClaimStore {
  private injected = false;

  override async compareAndSwap(
    id: string,
    expectedVersion: number,
    next: ClaimSession,
  ): Promise<{ session: ClaimSession; won: boolean }> {
    if (!this.injected && next.state === "completed") {
      this.injected = true;
      const current = await this.get(id);
      if (!current) {
        throw new DomainError("NOT_FOUND", "Claim not found", { id });
      }
      const denied: ClaimSession = {
        ...current,
        state: "denied",
        completedAt: fixtures.now,
        version: current.version + 1,
      };
      const persisted = await super.compareAndSwap(id, expectedVersion, denied);
      return { session: persisted.session, won: false };
    }
    return super.compareAndSwap(id, expectedVersion, next);
  }
}

describe("ClaimEngine.createClaim", () => {
  it("records every optional creator, proof, and request field", async () => {
    const eng = engine(() => fixtures.now);
    const { session } = await eng.createClaim({
      type: "connection",
      targetManifest: { kind: "env", name: "demo" },
      creatorPrincipalId: "prn_creator",
      creatorAgentId: "agt_001",
      creatorInstanceId: "inst_001",
      proofKeyJkt: "jkt_001",
      requestedDestination: { principalId: "prn_dest" },
      requestedGrant: { scope: "read" },
      publicId: "pub_fixed_001",
    });
    expect(session.id).toBe("pub_fixed_001");
    expect(session.creatorPrincipalId).toBe("prn_creator");
    expect(session.creatorAgentId).toBe("agt_001");
    expect(session.creatorInstanceId).toBe("inst_001");
    expect(session.proofKeyJkt).toBe("jkt_001");
    expect(session.requestedDestination).toEqual({ principalId: "prn_dest" });
    expect(session.requestedGrant).toEqual({ scope: "read" });
    // Default TTL is ten minutes.
    expect(session.expiresAt.getTime() - session.createdAt.getTime()).toBe(
      600_000,
    );
  });

  it("omits optional fields that were not supplied", async () => {
    const eng = engine();
    const { session } = await eng.createClaim({
      type: "project",
      targetManifest: { a: 1 },
    });
    expect(session.creatorPrincipalId).toBeUndefined();
    expect(session.creatorAgentId).toBeUndefined();
    expect(session.creatorInstanceId).toBeUndefined();
    expect(session.proofKeyJkt).toBeUndefined();
    expect(session.requestedDestination).toBeUndefined();
    expect(session.requestedGrant).toBeUndefined();
  });
});

describe("ClaimEngine lookup and token checks", () => {
  it("returns undefined for unknown claims", async () => {
    const eng = engine();
    expect(await eng.get("clm_missing")).toBeUndefined();
  });

  it("rejects transitions on unknown claims with NOT_FOUND", async () => {
    const eng = engine();
    await expect(
      eng.presentClaim("clm_missing", "osc_clm_x.y"),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(eng.authenticateClaim("clm_missing")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(
      eng.completeClaim("clm_missing", "prn_x", { acceptedItemIds: [] }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("rejects presentation with a token that does not match the digest", async () => {
    const eng = engine();
    const created = await eng.createClaim({
      type: "project",
      targetManifest: { a: 1 },
    });
    const other = await eng.createClaim({
      type: "project",
      targetManifest: { b: 2 },
    });
    await expect(
      eng.presentClaim(created.session.id, other.token),
    ).rejects.toMatchObject({ code: "INVALID_TOKEN" });
    // The failed presentation must not have moved the claim.
    expect((await eng.get(created.session.id))?.state).toBe("pending");
  });
});

describe("ClaimEngine terminal transitions", () => {
  it("denies a reviewed claim", async () => {
    const eng = engine(() => fixtures.now);
    const created = await advanceToReviewed(eng);
    const denied = await eng.deny(created.session.id);
    expect(denied.state).toBe("denied");
    expect(denied.completedAt).toEqual(fixtures.now);
  });

  it("rejects denying a claim that is still pending", async () => {
    const eng = engine();
    const created = await eng.createClaim(bundleInput("placeholder"));
    await expect(eng.deny(created.session.id)).rejects.toMatchObject({
      code: "INVALID_TRANSITION",
    });
  });

  it("revokes a pending claim and refuses to revoke it twice", async () => {
    const eng = engine(() => fixtures.now);
    const created = await eng.createClaim(bundleInput("placeholder"));
    const revoked = await eng.revoke(created.session.id);
    expect(revoked.state).toBe("revoked");
    expect(revoked.revokedAt).toEqual(fixtures.now);
    await expect(eng.revoke(created.session.id)).rejects.toMatchObject({
      code: "INVALID_TRANSITION",
    });
  });

  it("refuses to revoke a completed claim", async () => {
    const eng = engine(() => fixtures.now);
    const created = await advanceToReviewed(eng);
    await eng.completeClaim(created.session.id, "prn_winner", {
      acceptedItemIds: ["ci_project", "ci_resource"],
    });
    await expect(eng.revoke(created.session.id)).rejects.toMatchObject({
      code: "INVALID_TRANSITION",
    });
  });

  it("expires a live claim explicitly and reports re-expiry as EXPIRED", async () => {
    const eng = engine(() => fixtures.now);
    const created = await eng.createClaim(bundleInput("placeholder"));
    const expired = await eng.expire(created.session.id);
    expect(expired.state).toBe("expired");
    // The engine short-circuits expired claims before the state machine runs.
    await expect(eng.expire(created.session.id)).rejects.toMatchObject({
      code: "EXPIRED",
    });
  });
});

describe("ClaimEngine concurrency bounds", () => {
  it("gives up with CONFLICT after the bounded CAS retries", async () => {
    const eng = new ClaimEngine({
      pepper: fixtures.pepper,
      store: new LosingStore(),
      clock: () => fixtures.now,
    });
    const created = await eng.createClaim(bundleInput("placeholder"));
    await expect(
      eng.presentClaim(created.session.id, created.token),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("refuses completion attempts beyond the recursion bound", async () => {
    const eng = engine();
    await expect(
      eng.completeClaim("clm_any", "prn_x", { acceptedItemIds: [] }, 8),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });
});

describe("ClaimEngine.completeClaim state handling", () => {
  it("rejects completion of an expired claim", async () => {
    let now = fixtures.now.getTime();
    const eng = engine(() => new Date(now));
    const created = await eng.createClaim({
      type: "project",
      targetManifest: { x: 1 },
      ttlMs: 1000,
    });
    now += 2000;
    await expect(
      eng.completeClaim(created.session.id, "prn_x", { acceptedItemIds: [] }),
    ).rejects.toMatchObject({ code: "EXPIRED" });
  });

  it("rejects completion from pending before any review happened", async () => {
    const eng = engine();
    const created = await eng.createClaim(bundleInput("placeholder"));
    await expect(
      eng.completeClaim(created.session.id, "prn_x", {
        acceptedItemIds: ["ci_project", "ci_resource"],
      }),
    ).rejects.toMatchObject({ code: "INVALID_TRANSITION" });
  });

  it("auto-reviews an authenticated claim and completes it in one call", async () => {
    const eng = engine(() => fixtures.now);
    const created = await advanceToAuthenticated(eng);
    const decision = {
      acceptedItemIds: ["ci_project", "ci_resource"],
      destination: { principalId: "prn_dest" },
      idempotencyKey: "idem-001",
    };
    const result = await eng.completeClaim(
      created.session.id,
      "prn_direct",
      decision,
    );
    expect(result.won).toBe(true);
    expect(result.session.state).toBe("completed");
    expect(result.session.reviewDecision).toEqual({
      acceptedItemIds: ["ci_project", "ci_resource"],
      destination: { principalId: "prn_dest" },
      idempotencyKey: "idem-001",
    });
    for (const item of await eng.getItems(created.session.id)) {
      expect(item.state).toBe("accepted");
    }
  });

  it("recovers when a concurrent reviewer wins the review swap", async () => {
    const store = new ConcurrentReviewerStore();
    const eng = new ClaimEngine({
      pepper: fixtures.pepper,
      store,
      clock: () => fixtures.now,
    });
    const created = await advanceToAuthenticated(eng);
    const result = await eng.completeClaim(created.session.id, "prn_direct", {
      acceptedItemIds: ["ci_project", "ci_resource"],
    });
    expect(result.won).toBe(true);
    expect(result.session.state).toBe("completed");
    expect(result.session.completedByPrincipalId).toBe("prn_direct");
  });

  it("reports success when a concurrent identical completion wins the swap", async () => {
    const store = new ConcurrentCompleterStore();
    const eng = new ClaimEngine({
      pepper: fixtures.pepper,
      store,
      clock: () => fixtures.now,
    });
    const created = await advanceToReviewed(eng);
    const result = await eng.completeClaim(created.session.id, "prn_same", {
      acceptedItemIds: ["ci_project", "ci_resource"],
    });
    // Same principal, same decision: the recorded win counts as ours.
    expect(result.won).toBe(true);
    expect(result.session.state).toBe("completed");
    for (const item of await eng.getItems(created.session.id)) {
      expect(item.state).toBe("accepted");
    }
  });

  it("raises CONFLICT when the swap is lost to an incompatible transition", async () => {
    const store = new ConcurrentDenierStore();
    const eng = new ClaimEngine({
      pepper: fixtures.pepper,
      store,
      clock: () => fixtures.now,
    });
    const created = await advanceToReviewed(eng);
    await expect(
      eng.completeClaim(created.session.id, "prn_loser", {
        acceptedItemIds: ["ci_project", "ci_resource"],
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect((await eng.get(created.session.id))?.state).toBe("denied");
  });
});

describe("ClaimEngine.completeClaim replay matching", () => {
  it("rejects a replay whose accepted list is a different length", async () => {
    const eng = engine(() => fixtures.now);
    const created = await advanceToReviewed(eng);
    await eng.completeClaim(created.session.id, "prn_same", {
      acceptedItemIds: ["ci_project", "ci_resource"],
    });
    await expect(
      eng.completeClaim(created.session.id, "prn_same", {
        acceptedItemIds: ["ci_project"],
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("rejects a replay whose accepted ids differ at the same length", async () => {
    const eng = engine(() => fixtures.now);
    const created = await advanceToReviewed(eng);
    await eng.completeClaim(created.session.id, "prn_same", {
      acceptedItemIds: ["ci_project", "ci_resource"],
    });
    await expect(
      eng.completeClaim(created.session.id, "prn_same", {
        acceptedItemIds: ["ci_project", "ci_other"],
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("rejects a replay when the record carries no decision at all", async () => {
    const store = new MemoryClaimStore();
    const eng = new ClaimEngine({
      pepper: fixtures.pepper,
      store,
      clock: () => fixtures.now,
    });
    const created = await eng.createClaim(bundleInput("placeholder"));
    const current = await store.get(created.session.id);
    if (!current) throw new Error("seed claim missing");
    // A completed row written outside the engine may carry no reviewDecision.
    const seeded: ClaimSession = {
      ...current,
      state: "completed",
      completedAt: fixtures.now,
      completedByPrincipalId: "prn_seed",
      version: current.version + 1,
    };
    await store.compareAndSwap(created.session.id, current.version, seeded);
    await expect(
      eng.completeClaim(created.session.id, "prn_seed", {
        acceptedItemIds: [],
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("rejects a replay when the recorded accepted list is malformed", async () => {
    const store = new MemoryClaimStore();
    const eng = new ClaimEngine({
      pepper: fixtures.pepper,
      store,
      clock: () => fixtures.now,
    });
    const created = await eng.createClaim(bundleInput("placeholder"));
    const current = await store.get(created.session.id);
    if (!current) throw new Error("seed claim missing");
    const seeded: ClaimSession = {
      ...current,
      state: "completed",
      completedAt: fixtures.now,
      completedByPrincipalId: "prn_seed",
      reviewDecision: { acceptedItemIds: "ci_project" },
      version: current.version + 1,
    };
    await store.compareAndSwap(created.session.id, current.version, seeded);
    await expect(
      eng.completeClaim(created.session.id, "prn_seed", {
        acceptedItemIds: ["ci_project"],
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });
});
