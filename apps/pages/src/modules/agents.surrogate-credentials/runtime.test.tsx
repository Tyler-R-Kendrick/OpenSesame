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

describe("agents.surrogate-credentials runtime", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("imports with no fetch, timer, DOM or storage side effect", async () => {
    const loaded = await importUnderSpies(() => import("./runtime.js"));
    runtime = loaded.module;
    expect(loaded.effects).toEqual(NO_SIDE_EFFECTS);
    expect(runtime.capabilityRuntime.capability).toBe(
      "agents.surrogate-credentials",
    );
  });

  it("registers the plugin tile in its section and its walkthrough", async () => {
    await expectLifecycle(runtimeOf(runtime), {
      capability: "agents.surrogate-credentials",
      kinds: ["settings-panel", "tutorial-target", "tutorial-goal"],
      count: 3,
    });
  });

  it("draws in the Surrogate credentials section, lists no file, and reaches no network on activation", async () => {
    const fetcher = vi.spyOn(globalThis, "fetch");
    const t = createTestContext();
    const handle = await runtime.capabilityRuntime.activate(t.ctx);
    const [panel] = t.entries("settings-panel");
    expect(panel?.id).toBe("plugin-surrogate-proxy");
    expect(panel?.category).toBe("capabilities.feature-surrogates");
    // No daemon is paired here: nothing is listed, nothing is asked.
    expect(panel?.files?.list()).toEqual([]);
    await Promise.resolve();
    expect(t.egressCalls).toEqual([]);
    expect(fetcher).not.toHaveBeenCalled();
    await handle.dispose();
    await handle.dispose();
  });
});
