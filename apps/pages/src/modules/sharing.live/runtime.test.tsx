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

describe("sharing.live runtime", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("imports with no fetch, timer, DOM or storage side effect", async () => {
    const loaded = await importUnderSpies(() => import("./runtime.js"));
    runtime = loaded.module;
    expect(loaded.effects).toEqual(NO_SIDE_EFFECTS);
    expect(runtime.capabilityRuntime.capability).toBe("sharing.live");
  });

  it("registers the join route and the host panel", async () => {
    await expectLifecycle(runtimeOf(runtime), {
      capability: "sharing.live",
      kinds: ["route", "settings-panel"],
      count: 2,
    });
  });

  it("serves the join screen on a locked device, and reaches no relay on activation", async () => {
    const socket = vi.fn();
    vi.stubGlobal("WebSocket", socket);
    const t = createTestContext();
    const handle = await runtime.capabilityRuntime.activate(t.ctx);
    const [route] = t.entries("route");
    expect(route?.path).toBe("/live");
    expect(route?.gate).toBe("any");
    expect(t.egressCalls).toEqual([]);
    expect(socket).not.toHaveBeenCalled();
    await handle.dispose();
    await handle.dispose();
    vi.unstubAllGlobals();
  });
});
