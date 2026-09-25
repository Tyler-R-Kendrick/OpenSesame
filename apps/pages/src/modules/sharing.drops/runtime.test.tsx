/** @vitest-environment jsdom */
import { describe, expect, it } from "vitest";
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

  it("registers the drop opener and the drop item kind (LOAD-09)", async () => {
    await expectLifecycle(runtimeOf(runtime), {
      capability: "sharing.drops",
      kinds: ["claim-opener", "item-kind"],
      count: 2,
    });
  });

  it("serves no route: /claim is identity.ceremonies', which draws this opener", async () => {
    const { DropClaimScreen } = await import(
      "../../screens/DropClaimScreen.js"
    );
    const t = createTestContext();
    const handle = await runtime.capabilityRuntime.activate(t.ctx);
    expect(t.entries("route")).toEqual([]);
    expect(
      t.entries("claim-opener").map((o) => [o.id, o.link, o.Opener]),
    ).toEqual([["drop", "drop", DropClaimScreen]]);
    expect(
      t.entries("item-kind").map((k) => [k.kind, k.label, k.segment, k.order]),
    ).toEqual([["drop", "Drop", "drops", 50]]);
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
});
