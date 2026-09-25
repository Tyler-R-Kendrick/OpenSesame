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

describe("notifications.routing runtime", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("imports with no fetch, timer, DOM or storage side effect", async () => {
    const loaded = await importUnderSpies(() => import("./runtime.js"));
    runtime = loaded.module;
    expect(loaded.effects).toEqual(NO_SIDE_EFFECTS);
    expect(runtime.capabilityRuntime.capability).toBe("notifications.routing");
  });

  it("registers the Notifications settings category and its walkthrough", async () => {
    await expectLifecycle(runtimeOf(runtime), {
      capability: "notifications.routing",
      kinds: [
        "settings-category",
        "tutorial-target",
        "tutorial-goal",
        "tutorial-route",
      ],
      count: 4,
    });
  });

  it("carries its files with the category, and reaches no network on activation", async () => {
    const fetcher = vi.spyOn(globalThis, "fetch");
    const t = createTestContext();
    const handle = await runtime.capabilityRuntime.activate(t.ctx);
    const [category] = t.entries("settings-category");
    expect(category?.id).toBe("notifications");
    expect(category?.label).toBe("Notifications");
    expect(category?.guideId).toBe("settings.notifications");
    // No Identity API is configured here: nothing is listed, nothing asked.
    expect(category?.files?.list()).toEqual([]);
    await Promise.resolve();
    expect(t.egressCalls).toEqual([]);
    expect(fetcher).not.toHaveBeenCalled();
    await handle.dispose();
    await handle.dispose();
  });
});
