/** @vitest-environment jsdom */
import type { RegistrationHandle } from "@opensesame/capability-composition";
import { afterEach, describe, expect, it, vi } from "vitest";

// The SDK is exclusive to this capability and must not be touched unless
// the capability is activated. The mock records any access to it.
const sdk = vi.hoisted(() => ({
  detect: vi.fn(() => null),
  createRegistrar: vi.fn(() => ({ register: () => () => {} })),
}));
vi.mock("@opensesame/webmcp", () => ({
  detectModelContext: sdk.detect,
  createWebMcpRegistrar: sdk.createRegistrar,
}));

import { resetContributionsForTest } from "../../lib/contributions.js";
import { webmcpNavigationSeam } from "../../webmcp/navigation.js";
import type { ContextWithPorts, ShellWrapperContribution } from "../ports-b.js";
import {
  NO_SIDE_EFFECTS,
  expectLifecycle,
  importUnderSpies,
  runtimeOf,
} from "../runtime-test-kit.js";
import { createTestContext } from "../test-context.js";
import type * as Runtime from "./runtime.js";

let runtime: typeof Runtime;

describe("agents.webmcp runtime", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    sdk.detect.mockClear();
    sdk.createRegistrar.mockClear();
    resetContributionsForTest();
  });

  it("imports with no fetch, timer, DOM or storage side effect", async () => {
    const loaded = await importUnderSpies(() => import("./runtime.js"));
    runtime = loaded.module;
    expect(loaded.effects).toEqual(NO_SIDE_EFFECTS);
    expect(runtime.capabilityRuntime.capability).toBe("agents.webmcp");
  });

  it("never touches the WebMCP SDK on import", () => {
    expect(sdk.detect).not.toHaveBeenCalled();
    expect(sdk.createRegistrar).not.toHaveBeenCalled();
  });

  it("registers the boot tools and the job, and disposes them (LOAD-09)", async () => {
    await expectLifecycle(runtimeOf(runtime), {
      capability: "agents.webmcp",
      kinds: ["background-job", "webmcp-tool"],
      // three boot tools + the registration job
      count: 3 + 1,
    });
  });

  it("tags each boot tool and leaves the SDK alone until the job starts", async () => {
    const t = createTestContext();
    const handle = await runtime.capabilityRuntime.activate(t.ctx);
    const tools = t.entries("webmcp-tool");
    expect(tools.map((tool) => tool.name)).toEqual([
      "opensesame_status",
      "opensesame_navigate",
      "opensesame_health",
    ]);
    expect(
      tools.map((tool) => (tool as { operationId?: string }).operationId),
    ).toEqual(["app.status", "app.navigate", "identity.health.pages"]);
    expect(t.entries("background-job").map((job) => job.id)).toEqual([
      "webmcp-boot",
    ]);
    expect(sdk.detect).not.toHaveBeenCalled();
    await handle.dispose();
  });

  it("points the navigation seam at the router only while the job runs", async () => {
    const before = webmcpNavigationSeam.navigate;
    const navigate = vi.fn();
    const t = createTestContext();
    const ctx: ContextWithPorts = { ...t.ctx, navigate };
    const handle = await runtime.capabilityRuntime.activate(ctx);
    const [job] = t.entries("background-job");
    const controller = new AbortController();
    job?.start(controller.signal);
    expect(webmcpNavigationSeam.navigate).toBe(navigate);

    controller.abort("disabled");
    expect(webmcpNavigationSeam.navigate).toBe(before);
    await handle.dispose();
    expect(webmcpNavigationSeam.navigate).toBe(before);
  });

  it("offers the session binding through the wrapper port and revokes it", async () => {
    const revoke = vi.fn();
    const registerShellWrapper = vi.fn(
      (_entry: ShellWrapperContribution): RegistrationHandle => ({
        kind: "section",
        capability: "agents.webmcp",
        generation: 1,
        revoke,
      }),
    );
    const t = createTestContext();
    const ctx: ContextWithPorts = { ...t.ctx, registerShellWrapper };
    const handle = await runtime.capabilityRuntime.activate(ctx);
    expect(registerShellWrapper.mock.calls[0]?.[0]).toMatchObject({
      id: "webmcp-session",
      order: 20,
    });
    await handle.dispose();
    expect(revoke).toHaveBeenCalledTimes(1);
    await handle.dispose();
    expect(revoke).toHaveBeenCalledTimes(1);
  });
});
