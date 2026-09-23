/** @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { issueAccessContext } from "../access/context.js";
import { createMemoryFenceStore, preferDurableFence } from "./durable.js";
import { DuressSessionFence } from "./fence.js";

describe("durable fence (AUTH-C/E/F)", () => {
  let store: Map<string, string>;

  beforeEach(() => {
    store = new Map();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => {
        store.set(k, v);
      },
      removeItem: (k: string) => {
        store.delete(k);
      },
      clear: () => store.clear(),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("prefers higher durable epoch over stale memory", async () => {
    const fence = new DuressSessionFence("sess-test");
    fence.activate({
      incidentId: "i1",
      policyRevision: 1,
      keyEpoch: 1,
      denyOperations: ["export_root"],
      admittedCompartmentRefs: ["c1"],
    });
    const snap = fence.readFence();
    const mem = createMemoryFenceStore();
    await mem.set({
      ...snap,
      incidentEpoch: snap.incidentEpoch + 5,
      denyOperations: ["export_root", "mint_grant"],
    });
    const durable = await mem.get();
    const preferred = preferDurableFence(fence.readFence(), durable);
    expect(preferred.incidentEpoch).toBe(snap.incidentEpoch + 5);
    expect(preferred.denyOperations).toContain("mint_grant");
  });

  it("lost BroadcastChannel: peer rehydrates from durable localStorage", () => {
    const a = new DuressSessionFence("chan-writer");
    a.activate({
      incidentId: "i1",
      policyRevision: 3,
      keyEpoch: 2,
      denyOperations: ["export_root"],
      admittedCompartmentRefs: ["c1", "c2"],
    });
    // New tab instance that missed the broadcast still sees durable fence.
    const b = new DuressSessionFence("chan-missed");
    expect(b.readFence().incidentEpoch).toBe(a.readFence().incidentEpoch);
    expect(b.readFence().denyOperations).toContain("export_root");
    expect(b.currentContext()).toBeNull();
  });

  it("rejects nested fence lock reentry", async () => {
    const fence = new DuressSessionFence("sess-lock");
    await expect(
      fence.withFenceLock(async () =>
        fence.withFenceLock(async () => "nested"),
      ),
    ).rejects.toThrow(/fence_lock_reentry/);
  });

  it("rejects stale resolution epochs (AT-040)", () => {
    const fence = new DuressSessionFence("sess-stale");
    fence.activate({
      incidentId: "i1",
      policyRevision: 1,
      keyEpoch: 1,
      denyOperations: ["export_root"],
      admittedCompartmentRefs: ["c1"],
    });
    const epoch = fence.readFence().incidentEpoch;
    fence.activate({
      incidentId: "i2",
      policyRevision: 1,
      keyEpoch: 1,
      denyOperations: ["mint_grant"],
      admittedCompartmentRefs: ["c1"],
    });
    expect(() => fence.resolve(["i1", "i2"], true, epoch)).toThrow(
      /stale_resolution/,
    );
  });

  it("narrows compartments monotonically; partial resolve keeps denies", () => {
    const fence = new DuressSessionFence("sess-mono");
    fence.activate({
      incidentId: "i1",
      policyRevision: 1,
      keyEpoch: 1,
      denyOperations: ["export_root"],
      admittedCompartmentRefs: ["c1", "c2"],
    });
    fence.activate({
      incidentId: "i2",
      policyRevision: 1,
      keyEpoch: 1,
      denyOperations: ["mint_grant"],
      admittedCompartmentRefs: ["c2", "c3"],
    });
    expect(fence.readFence().admittedCompartmentRefs).toEqual(["c2"]);
    fence.resolve(["i1"], true, fence.readFence().incidentEpoch);
    expect(fence.readFence().activeIncidentIds).toEqual(["i2"]);
    expect(fence.readFence().denyOperations).toContain("export_root");
  });

  it("BFCache restore drops live context and bumps generation (AT-038)", () => {
    const fence = new DuressSessionFence("sess-bfcache");
    fence.activate({
      incidentId: "i1",
      policyRevision: 1,
      keyEpoch: 1,
      denyOperations: ["export_root"],
      admittedCompartmentRefs: ["c1"],
    });
    const ctx = issueAccessContext({
      principalRef: "p1",
      tenantRef: null,
      vaultRef: "v1",
      compartmentRefs: ["c1"],
      deviceBindingRef: "d1",
      presentation: "restricted",
      authorizationCeiling: ["read_item"],
      denyOperations: ["export_root"],
      policyRevision: 1,
      incidentEpoch: fence.readFence().incidentEpoch,
      keyEpoch: 1,
      sessionGeneration: fence.guard.generation,
      profileId: "p",
      evidenceDigest: "digest0123456789ab",
    });
    fence.setContext(ctx);
    const genBefore = fence.guard.generation;
    const ev = new Event("pageshow");
    Object.defineProperty(ev, "persisted", { value: true });
    globalThis.dispatchEvent(ev);
    expect(fence.currentContext()).toBeNull();
    expect(fence.guard.generation).toBeGreaterThan(genBefore);
  });
});
