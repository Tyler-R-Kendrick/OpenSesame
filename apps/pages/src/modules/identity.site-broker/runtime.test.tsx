/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  NO_SIDE_EFFECTS,
  expectLifecycle,
  importUnderSpies,
  runtimeOf,
} from "../runtime-test-kit.js";
import { createTestContext } from "../test-context.js";
import type * as Runtime from "./runtime.js";

let runtime: typeof Runtime;

describe("identity.site-broker runtime", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("imports with no fetch, timer, DOM, storage or postMessage listener", async () => {
    const loaded = await importUnderSpies(() => import("./runtime.js"));
    runtime = loaded.module;
    expect(loaded.effects).toEqual(NO_SIDE_EFFECTS);
    expect(runtime.capabilityRuntime.capability).toBe("identity.site-broker");
  });

  it("registers the broker popup route and disposes it (LOAD-09)", async () => {
    await expectLifecycle(runtimeOf(runtime), {
      capability: "identity.site-broker",
      kinds: ["route"],
      count: 1,
    });
  });

  it("serves /broker/authorize on a locked device, unframed", async () => {
    const t = createTestContext();
    const handle = await runtime.capabilityRuntime.activate(t.ctx);
    expect(
      t.entries("route").map((r) => [r.id, r.path, r.framed, r.gate]),
    ).toEqual([["broker-authorize", "/broker/authorize", false, "any"]]);
    expect(t.egressCalls).toEqual([]);
    await handle.dispose();
  });
});
