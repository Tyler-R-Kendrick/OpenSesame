/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { currentTailnetDevices } from "../../sections/identity/tailnet-devices-slot.js";
import {
  NO_SIDE_EFFECTS,
  expectLifecycle,
  importUnderSpies,
  runtimeOf,
} from "../runtime-test-kit.js";
import { createTestContext } from "../test-context.js";
import type * as Runtime from "./runtime.js";

let runtime: typeof Runtime;

describe("networking.tailnet-devices runtime", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("imports with no fetch, timer, DOM or storage side effect", async () => {
    const loaded = await importUnderSpies(() => import("./runtime.js"));
    runtime = loaded.module;
    expect(loaded.effects).toEqual(NO_SIDE_EFFECTS);
    expect(runtime.capabilityRuntime.capability).toBe(
      "networking.tailnet-devices",
    );
  });

  it("registers nothing in the shell; its panels go in the Devices slot", async () => {
    await expectLifecycle(runtimeOf(runtime), {
      capability: "networking.tailnet-devices",
      kinds: [],
      count: 0,
    });
  });

  it("fills the slot on activation, reaches no network, and empties it on dispose", async () => {
    const t = createTestContext();
    expect(currentTailnetDevices()).toBeNull();
    const handle = await runtime.capabilityRuntime.activate(t.ctx);
    expect(currentTailnetDevices()).not.toBeNull();
    expect(t.egressCalls).toEqual([]);
    await handle.dispose();
    expect(currentTailnetDevices()).toBeNull();
    await handle.dispose();
  });
});
