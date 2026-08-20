import { DomainError, fixtures } from "@opensesame/os-domain";
import { describe, expect, it } from "vitest";
import { ClaimEngine, MemoryClaimStore } from "../index.js";

function engine(clock?: () => Date) {
  return new ClaimEngine({
    pepper: fixtures.pepper,
    store: new MemoryClaimStore(),
    ...(clock ? { clock } : undefined),
  });
}

async function advanceToReviewed(eng: ClaimEngine) {
  const created = await eng.createClaim({
    type: "resource_bundle",
    targetManifest: { targets: [{ id: "prj_temp_001" }] },
    creatorPrincipalId: "prn_creator",
    items: fixtures.claimItems("placeholder"),
  });
  await eng.presentClaim(created.session.id, created.token);
  await eng.authenticateClaim(created.session.id);
  await eng.reviewClaim(created.session.id, {
    acceptedItemIds: ["ci_project", "ci_resource"],
  });
  return created;
}

describe("ClaimEngine", () => {
  it("creates claim with immutable manifest digest", async () => {
    const eng = engine();
    const { session, token } = await eng.createClaim({
      type: "project",
      targetManifest: { a: 1, b: [2] },
    });
    expect(token.startsWith("osc_clm_")).toBe(true);
    expect(session.targetManifestDigest.startsWith("sha256:")).toBe(true);
    expect(session.state).toBe("pending");
  });

  it("rejects token replay after completion", async () => {
    const eng = engine();
    const created = await advanceToReviewed(eng);
    const { session } = await eng.completeClaim(
      created.session.id,
      "prn_winner",
      { acceptedItemIds: ["ci_project", "ci_resource"] },
    );
    expect(session.state).toBe("completed");
    await expect(
      eng.presentClaim(created.session.id, created.token),
    ).rejects.toBeInstanceOf(DomainError);
  });

  it("expires via injected clock", async () => {
    let now = fixtures.now.getTime();
    const eng = engine(() => new Date(now));
    const created = await eng.createClaim({
      type: "project",
      targetManifest: { x: 1 },
      ttlMs: 1000,
    });
    now += 2000;
    await expect(
      eng.presentClaim(created.session.id, created.token),
    ).rejects.toMatchObject({ code: "EXPIRED" });
  });

  it("enforces partial claim dependency closure", async () => {
    const eng = engine();
    const created = await eng.createClaim({
      type: "resource_bundle",
      targetManifest: { targets: [] },
      items: fixtures.claimItems("x"),
    });
    await eng.presentClaim(created.session.id, created.token);
    await eng.authenticateClaim(created.session.id);
    await eng.reviewClaim(created.session.id, {
      acceptedItemIds: ["ci_resource"],
    });
    await expect(
      eng.completeClaim(created.session.id, "prn_x", {
        acceptedItemIds: ["ci_resource"],
      }),
    ).rejects.toMatchObject({ code: "DEPENDENCY_CLOSURE" });
  });

  it("concurrent completion: exactly one winner via version CAS", async () => {
    const store = new MemoryClaimStore();
    const eng = new ClaimEngine({
      pepper: fixtures.pepper,
      store,
      clock: () => fixtures.now,
    });
    const created = await eng.createClaim({
      type: "resource_bundle",
      targetManifest: { t: 1 },
      items: fixtures.claimItems("x"),
    });
    await eng.presentClaim(created.session.id, created.token);
    await eng.authenticateClaim(created.session.id);
    await eng.reviewClaim(created.session.id, {
      acceptedItemIds: ["ci_project", "ci_resource"],
    });

    const decision = {
      acceptedItemIds: ["ci_project", "ci_resource"],
    };

    const [a, b] = await Promise.all([
      eng.completeClaim(created.session.id, "prn_a", decision),
      eng.completeClaim(created.session.id, "prn_b", decision),
    ]);

    const winners = [a, b].filter((r) => r.won);
    const losers = [a, b].filter((r) => !r.won);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect(winners[0]?.session.state).toBe("completed");
    expect(losers[0]?.session.state).toBe("completed");
    expect(winners[0]?.session.completedByPrincipalId).toBe(
      winners[0]?.session.completedByPrincipalId,
    );
    // Both see the same final completer (the CAS winner)
    expect(a.session.completedByPrincipalId).toBe(
      b.session.completedByPrincipalId,
    );
    const final = await eng.get(created.session.id);
    expect(final?.version).toBeGreaterThanOrEqual(5);
  });

  // Item rows are the record of what was accepted, so the decision that lost the
  // swap must not be the one written against them.
  it("leaves items matching the decision that won", async () => {
    const eng = engine(() => fixtures.now);
    const created = await advanceToReviewed(eng);

    const [a, b] = await Promise.all([
      eng.completeClaim(created.session.id, "prn_both", {
        acceptedItemIds: ["ci_project", "ci_resource"],
      }),
      eng.completeClaim(created.session.id, "prn_project_only", {
        acceptedItemIds: ["ci_project"],
      }),
    ]);

    const winners = [a, b].filter((r) => r.won);
    expect(winners).toHaveLength(1);
    const winner = winners[0];
    const accepted = new Set(
      winner?.session.completedByPrincipalId === "prn_both"
        ? ["ci_project", "ci_resource"]
        : ["ci_project"],
    );

    const items = await eng.getItems(created.session.id);
    for (const item of items) {
      expect(item.state).toBe(accepted.has(item.id) ? "accepted" : "rejected");
    }
  });

  // The session swap and the item rows are two writes. A completion that stopped
  // between them must not report success on retry while items say nothing.
  it("settles items on retry after the item write was lost", async () => {
    const store = new MemoryClaimStore();
    const eng = new ClaimEngine({
      pepper: fixtures.pepper,
      store,
      clock: () => fixtures.now,
    });
    const created = await eng.createClaim({
      type: "resource_bundle",
      targetManifest: { targets: [{ id: "prj_temp_001" }] },
      creatorPrincipalId: "prn_creator",
      items: fixtures.claimItems("placeholder"),
    });
    await eng.presentClaim(created.session.id, created.token);
    await eng.authenticateClaim(created.session.id);
    const decision = { acceptedItemIds: ["ci_project", "ci_resource"] };
    await eng.reviewClaim(created.session.id, decision);

    // The write of the item rows never lands.
    const putItems = store.putItems.bind(store);
    store.putItems = async () => {
      throw new Error("storage went away");
    };
    await expect(
      eng.completeClaim(created.session.id, "prn_owner", decision),
    ).rejects.toThrow("storage went away");
    expect(
      (await eng.getItems(created.session.id)).every(
        (item) => item.state === "pending",
      ),
    ).toBe(true);

    store.putItems = putItems;
    const retry = await eng.completeClaim(
      created.session.id,
      "prn_owner",
      decision,
    );
    expect(retry.won).toBe(true);
    for (const item of await eng.getItems(created.session.id)) {
      expect(item.state).toBe("accepted");
    }
  });

  // Same items, different destination: reporting the recorded completion as this
  // caller's success would say ownership went where it did not.
  it("refuses a replay that names a different destination", async () => {
    const eng = engine();
    const created = await advanceToReviewed(eng);
    const first = await eng.completeClaim(created.session.id, "prn_same", {
      acceptedItemIds: ["ci_project", "ci_resource"],
      destination: { principalId: "prn_a" },
    });
    expect(first.won).toBe(true);

    await expect(
      eng.completeClaim(created.session.id, "prn_same", {
        acceptedItemIds: ["ci_project", "ci_resource"],
        destination: { principalId: "prn_b" },
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    // Key order is not a difference.
    const same = await eng.completeClaim(created.session.id, "prn_same", {
      acceptedItemIds: ["ci_resource", "ci_project"],
      destination: { principalId: "prn_a" },
    });
    expect(same.won).toBe(true);
  });

  it("idempotent complete returns recorded result", async () => {
    const eng = engine();
    const created = await advanceToReviewed(eng);
    const decision = {
      acceptedItemIds: ["ci_project", "ci_resource"],
      idempotencyKey: "k1",
    };
    const first = await eng.completeClaim(
      created.session.id,
      "prn_same",
      decision,
    );
    const second = await eng.completeClaim(
      created.session.id,
      "prn_same",
      decision,
    );
    expect(first.won).toBe(true);
    expect(second.won).toBe(true);
    expect(second.session.completedByPrincipalId).toBe("prn_same");
  });
});
