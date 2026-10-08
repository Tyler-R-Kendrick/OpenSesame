/** @vitest-environment jsdom */
import { dropSeams } from "@opensesame/app-core/lib/vault/drop.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import type { DropItem } from "@opensesame/vault-core";
import { describe, expect, it, vi } from "vitest";
import {
  NO_SIDE_EFFECTS,
  expectLifecycle,
  importUnderSpies,
  runtimeOf,
} from "../runtime-test-kit.js";
import { createTestContext } from "../test-context.js";
import type * as Runtime from "./runtime.js";

let runtime: typeof Runtime;

describe("sharing.drops runtime", () => {
  it("imports with no fetch, timer, DOM or storage side effect", async () => {
    const loaded = await importUnderSpies(() => import("./runtime.js"));
    runtime = loaded.module;
    expect(loaded.effects).toEqual(NO_SIDE_EFFECTS);
  });

  it("registers the legacy record, the share offer and the sweep (LOAD-09)", async () => {
    await expectLifecycle(runtimeOf(runtime), {
      capability: "sharing.drops",
      kinds: [
        "item-kind",
        "secret-share",
        "tutorial-goal",
        "tutorial-target",
        "unlock-effect",
      ],
      count: 5,
    });
  });

  it("shares any item and does not offer a drop to create", async () => {
    const t = createTestContext();
    const handle = await runtime.capabilityRuntime.activate(t.ctx);
    const [kind] = t.entries("item-kind");
    expect(kind?.creatable).toBe(false);
    expect(kind?.Record).toBeTypeOf("function");
    expect(kind?.Create).toBeUndefined();
    expect(t.entries("secret-share").map((s) => s.id)).toEqual(["drop"]);
    expect(t.entries("unlock-effect").map((e) => e.id)).toEqual(["drop-sweep"]);
    await handle.dispose();
  });

  it("serves no route: opening a drop at /claim is identity.ceremonies' (ADR 0140 D2)", async () => {
    const t = createTestContext();
    const handle = await runtime.capabilityRuntime.activate(t.ctx);
    expect(t.entries("route")).toEqual([]);
    expect(t.entries("item-kind").map((k) => [k.kind, k.creatable])).toEqual([
      ["drop", false],
    ]);
    await handle.dispose();
  });

  it("hydrates the claim plane's own kv keys, which the core boot no longer pulls", async () => {
    const { CORE_BOOT_KEYS } = await import("../../bootstrap/core-keys.js");
    const t = createTestContext();
    const handle = await runtime.capabilityRuntime.activate(t.ctx);
    expect(t.hydrated).toEqual([[...runtime.HYDRATE_KEYS]]);
    expect(runtime.HYDRATE_KEYS).toEqual([
      "opensesame.local-drop-claims.v1",
      "opensesame.local-drop-pepper.v1",
      "opensesame.outbound-drops.v1",
    ]);
    for (const key of runtime.HYDRATE_KEYS) {
      expect(CORE_BOOT_KEYS).not.toContain(key);
    }
    expect(t.egressCalls).toEqual([]);
    await handle.dispose();
  });

  it("registers nothing when the lease aborts while it hydrates", async () => {
    const t = createTestContext();
    const slowHydrate = new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
    const ctx = { ...t.ctx, hydrate: () => slowHydrate };
    const pending = runtime.capabilityRuntime.activate(ctx);
    t.abort("lock");
    const handle = await pending;
    expect(t.registered).toHaveLength(0);
    await handle.dispose();
  });

  it("sweeps a terminal drop record when the vault opens, without polling it", async () => {
    const consumed: DropItem = {
      id: "itm_drop",
      kind: "drop",
      name: "Deploy token",
      folderId: null,
      favorite: false,
      notes: "",
      fields: [],
      createdAt: "2026-08-01T00:00:00Z",
      updatedAt: "2026-08-01T00:00:00Z",
      deletedAt: null,
      state: "consumed",
      claimId: "clm_test",
      bearerToken: "osc_clm_clm_test.secret",
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
    };
    const snapshot = vi
      .spyOn(vaultStore, "getSnapshot")
      .mockReturnValue({ ...vaultStore.getSnapshot(), items: [consumed] });
    const purge = vi.spyOn(vaultStore, "purgeItem").mockResolvedValue();
    const poll = vi.fn();
    const previous = dropSeams.pollClaim;
    Object.assign(dropSeams, { pollClaim: poll });
    const t = createTestContext();
    const handle = await runtime.capabilityRuntime.activate(t.ctx);
    try {
      const [sweep] = t.entries("unlock-effect");
      await sweep?.run({
        tomb: "personal",
        guest: false,
        signal: new AbortController().signal,
      });
      expect(purge).toHaveBeenCalledWith("itm_drop");
      expect(poll).not.toHaveBeenCalled();
      // A run already superseded (its signal aborted) sweeps nothing.
      purge.mockClear();
      const aborted = new AbortController();
      aborted.abort();
      await sweep
        ?.run({ tomb: "personal", guest: false, signal: aborted.signal })
        .catch(() => undefined);
      expect(purge).not.toHaveBeenCalled();
    } finally {
      await handle.dispose();
      Object.assign(dropSeams, { pollClaim: previous });
      snapshot.mockRestore();
      purge.mockRestore();
    }
  });
});
