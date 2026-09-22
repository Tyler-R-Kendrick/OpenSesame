/** @vitest-environment jsdom */
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
      kinds: ["background-job", "shell-wrapper", "webmcp-tool"],
      // three boot tools + the registration job + the session wrapper
      count: 3 + 1 + 1,
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

  it("contributes the session binding as a shell wrapper and revokes it", async () => {
    const t = createTestContext();
    const handle = await runtime.capabilityRuntime.activate(
      t.ctx as ContextWithPorts,
    );
    const record = t.registered.find((entry) => entry.kind === "shell-wrapper");
    expect(record?.entry).toMatchObject({ id: "webmcp-session", order: 20 });
    expect(t.liveKinds()).toContain("shell-wrapper");
    await handle.dispose();
    expect(t.liveKinds()).not.toContain("shell-wrapper");
    await handle.dispose();
    expect(record?.revokeCalls).toBe(1);
  });
});
