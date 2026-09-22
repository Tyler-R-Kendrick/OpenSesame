/** @vitest-environment jsdom */
import type { RegistrationHandle } from "@opensesame/capability-composition";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ContextWithPorts,
  ShellWrapperContribution,
} from "../ports-b.js";
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
      kinds: ["webmcp-tool"],
      count: 2,
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
    const revoke = vi.fn();
    const registerShellWrapper = vi.fn(
      (_entry: ShellWrapperContribution): RegistrationHandle => ({
        kind: "section",
        capability: "support.guided-help",
        generation: 1,
        revoke,
      }),
    );
    const t = createTestContext();
    const ctx: ContextWithPorts = { ...t.ctx, registerShellWrapper };
    const handle = await runtime.capabilityRuntime.activate(ctx);
    expect(registerShellWrapper.mock.calls[0]?.[0]).toMatchObject({
      id: "support",
      order: 10,
    });
    expect(registerShellWrapper.mock.calls[0]?.[0].Wrapper).toBeTypeOf(
      "function",
    );
    await handle.dispose();
    expect(revoke).toHaveBeenCalledTimes(1);
    await handle.dispose();
    expect(revoke).toHaveBeenCalledTimes(1);
  });
});
