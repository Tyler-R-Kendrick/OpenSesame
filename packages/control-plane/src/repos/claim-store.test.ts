import type { ClaimSession } from "@opensesame/os-domain";
import { DomainError } from "@opensesame/os-domain";
import { describe, expect, it } from "vitest";
import { IndexedClaimStore } from "./claim-store.js";

function makeSession(
  id: string,
  overrides: Partial<ClaimSession> = {},
): ClaimSession {
  return {
    id,
    type: "project",
    state: "pending",
    tokenDigest: new Uint8Array(32),
    targetManifest: {},
    targetManifestDigest: `digest-${id}`,
    createdAt: new Date("2026-08-08T10:00:00Z"),
    expiresAt: new Date("2099-08-08T11:00:00Z"),
    version: 1,
    ...overrides,
  };
}

describe("IndexedClaimStore", () => {
  it("creates, reads, and lists sessions and items", async () => {
    const store = new IndexedClaimStore();
    const session = makeSession("clm_1");
    await store.create(session, []);

    expect(await store.get("clm_1")).toMatchObject({
      id: "clm_1",
      state: "pending",
    });
    expect(store.listIds()).toEqual(["clm_1"]);
    expect(store.listSessions()).toHaveLength(1);

    expect(await store.getItems("clm_1")).toEqual([]);
    const item = {
      id: "itm_1",
      claimId: "clm_1",
      targetType: "project" as const,
      targetId: "prj_1",
      requestedAction: "attach" as const,
      required: true,
      dependencies: [],
      state: "pending" as const,
    };
    await store.putItems("clm_1", [item]);
    expect(await store.getItems("clm_1")).toMatchObject([{ id: "itm_1" }]);

    expect(await store.get("clm_missing")).toBeUndefined();
  });

  it("returns clones so callers cannot mutate stored state", async () => {
    const store = new IndexedClaimStore();
    await store.create(makeSession("clm_1"), []);

    const fetched = await store.get("clm_1");
    if (!fetched) throw new Error("session missing");
    fetched.state = "denied";
    expect((await store.get("clm_1"))?.state).toBe("pending");

    const listed = store.listSessions();
    const first = listed[0];
    if (!first) throw new Error("expected a stored session");
    first.state = "revoked";
    expect((await store.get("clm_1"))?.state).toBe("pending");
  });

  it("rejects a duplicate session id with CONFLICT", async () => {
    const store = new IndexedClaimStore();
    await store.create(makeSession("clm_1"), []);
    const attempt = store.create(makeSession("clm_1"), []);
    await expect(attempt).rejects.toMatchObject({
      code: "CONFLICT",
      message: "Claim already exists",
    });
  });

  it("refuses new sessions once at capacity", async () => {
    const store = new IndexedClaimStore();
    for (let i = 0; i < 10_000; i += 1) {
      await store.create(makeSession(`clm_${i}`), []);
    }
    const overflow = store.create(makeSession("clm_overflow"), []);
    await expect(overflow).rejects.toBeInstanceOf(DomainError);
    await expect(overflow).rejects.toMatchObject({
      code: "CONFLICT",
      message: "Claim store at capacity",
    });
  }, 30_000);

  it("prunes expired sessions on access using the injected clock", async () => {
    let now = new Date("2026-08-08T10:00:00Z");
    const store = new IndexedClaimStore(() => now);
    await store.create(
      makeSession("clm_old", { expiresAt: new Date("2026-08-08T10:30:00Z") }),
      [],
    );
    await store.create(
      makeSession("clm_live", { expiresAt: new Date("2026-08-08T12:00:00Z") }),
      [],
    );

    now = new Date("2026-08-08T10:45:00Z");
    expect(await store.get("clm_old")).toBeUndefined();
    expect((await store.get("clm_live"))?.id).toBe("clm_live");
    expect(store.listIds()).toEqual(["clm_live"]);
  });

  it("compareAndSwap throws NOT_FOUND for an unknown session", async () => {
    const store = new IndexedClaimStore();
    await expect(
      store.compareAndSwap("clm_missing", 1, makeSession("clm_missing")),
    ).rejects.toMatchObject({ code: "NOT_FOUND", message: "Claim not found" });
  });

  it("compareAndSwap loses the race on a version mismatch", async () => {
    const store = new IndexedClaimStore();
    await store.create(makeSession("clm_1"), []);

    const stale = makeSession("clm_1", { state: "presented", version: 2 });
    const lost = await store.compareAndSwap("clm_1", 99, stale);
    expect(lost.won).toBe(false);
    expect(lost.session.version).toBe(1);
    // The losing write must not have landed.
    expect((await store.get("clm_1"))?.state).toBe("pending");
  });

  it("compareAndSwap rejects changes to the immutable manifest digest", async () => {
    const store = new IndexedClaimStore();
    await store.create(makeSession("clm_1"), []);

    const tampered = makeSession("clm_1", {
      targetManifestDigest: "digest-other",
      version: 2,
    });
    await expect(
      store.compareAndSwap("clm_1", 1, tampered),
    ).rejects.toMatchObject({
      code: "IMMUTABLE_FIELD",
      message: "targetManifestDigest is immutable",
    });
  });

  it("compareAndSwap stores and returns the winning session", async () => {
    const store = new IndexedClaimStore();
    await store.create(makeSession("clm_1"), []);

    const next = makeSession("clm_1", { state: "presented", version: 2 });
    const won = await store.compareAndSwap("clm_1", 1, next);
    expect(won.won).toBe(true);
    expect(won.session.state).toBe("presented");
    expect(won.session.version).toBe(2);
    expect((await store.get("clm_1"))?.state).toBe("presented");
  });
});
