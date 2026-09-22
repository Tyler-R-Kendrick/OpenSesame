/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ContextWithPorts } from "../ports-b.js";
import {
  NO_SIDE_EFFECTS,
  expectLifecycle,
  importUnderSpies,
  runtimeOf,
} from "../runtime-test-kit.js";
import { createTestContext } from "../test-context.js";
import type * as Runtime from "./runtime.js";

let runtime: typeof Runtime;

describe("support.guided-help runtime", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("imports with no fetch, timer, DOM or storage side effect", async () => {
    const loaded = await importUnderSpies(() => import("./runtime.js"));
    runtime = loaded.module;
    expect(loaded.effects).toEqual(NO_SIDE_EFFECTS);
    expect(runtime.capabilityRuntime.capability).toBe("support.guided-help");
  });

  it("registers the two guidance tools and disposes them (LOAD-09)", async () => {
    await expectLifecycle(runtimeOf(runtime), {
      capability: "support.guided-help",
      kinds: ["shell-wrapper", "webmcp-tool"],
      // two guidance tools + the support tree around the shell
      count: 2 + 1,
    });
  });

  it("tags each tool with the operation the core filters it by", async () => {
    const t = createTestContext();
    const handle = await runtime.capabilityRuntime.activate(t.ctx);
    const tools = t.entries("webmcp-tool");
    expect(tools.map((tool) => tool.name)).toEqual([
      "opensesame_help",
      "opensesame_guide_start",
    ]);
    expect(
      tools.map(
        (tool) => (tool as { operationId?: string }).operationId ?? null,
      ),
    ).toEqual(["client.support", "client.tutorial"]);
    await handle.dispose();
  });

  it("wraps the shell with the support tree and takes it back", async () => {
    // Through the contribution registry, not an optional port: the port this
    // used to call was never implemented, so it was `undefined` on every
    // real context and the Support key never appeared for an installation
    // that had approved guided help.
    const t = createTestContext();
    const handle = await runtime.capabilityRuntime.activate(
      t.ctx as ContextWithPorts,
    );
    const record = t.registered.find((entry) => entry.kind === "shell-wrapper");
    expect(record?.entry).toMatchObject({ id: "support", order: 10 });
    expect(
      (record?.entry as { Wrapper?: unknown } | undefined)?.Wrapper,
    ).toBeTypeOf("function");
    expect(t.liveKinds()).toContain("shell-wrapper");
    await handle.dispose();
    expect(t.liveKinds()).not.toContain("shell-wrapper");
    await handle.dispose();
    expect(record?.revokeCalls).toBe(1);
  });
});
