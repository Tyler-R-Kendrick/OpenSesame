/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  resetSupportAgentLoadersForTest,
  supportAgentLoaders,
} from "../../tutorial/agent-seams.js";
import {
  NO_SIDE_EFFECTS,
  expectLifecycle,
  importUnderSpies,
  runtimeOf,
} from "../runtime-test-kit.js";
import { createTestContext } from "../test-context.js";
import type * as Runtime from "./runtime.js";

let runtime: typeof Runtime;

describe("support.local-ai runtime", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    resetSupportAgentLoadersForTest();
  });

  it("imports with no fetch, timer, DOM or storage side effect", async () => {
    const loaded = await importUnderSpies(() => import("./runtime.js"));
    runtime = loaded.module;
    expect(loaded.effects).toEqual(NO_SIDE_EFFECTS);
    expect(runtime.capabilityRuntime.capability).toBe("support.local-ai");
  });

  it("registers the AI setup tab and the settings tool (LOAD-09)", async () => {
    await expectLifecycle(runtimeOf(runtime), {
      capability: "support.local-ai",
      kinds: ["setup-panel", "webmcp-tool"],
      count: 2,
    });
  });

  it("names the setup tab and the tool exactly", async () => {
    const t = createTestContext();
    const handle = await runtime.capabilityRuntime.activate(t.ctx);
    expect(
      t.entries("setup-panel").map((p) => [p.id, p.tab, p.rail, p.order]),
    ).toEqual([["ai", "ai", "AI", 20]]);
    expect(t.entries("webmcp-tool").map((tool) => tool.name)).toEqual([
      "opensesame_settings_read",
    ]);
    await handle.dispose();
  });

  it("installs the on-device loader only while active, and loads nothing", async () => {
    const absent = supportAgentLoaders.promptApi;
    const t = createTestContext();
    const handle = await runtime.capabilityRuntime.activate(t.ctx);
    expect(supportAgentLoaders.promptApi).not.toBe(absent);
    // Installing a loader is assigning a function: the adapter is fetched
    // when the panel asks, never on activation.
    expect(await absent()).toEqual({
      createPromptApiAgent: expect.any(Function),
    });

    await handle.dispose();
    expect(supportAgentLoaders.promptApi).toBe(absent);
    const restored = await supportAgentLoaders.promptApi();
    expect(restored.createPromptApiAgent()).toBeNull();
    await handle.dispose();
    expect(supportAgentLoaders.promptApi).toBe(absent);
  });
});
