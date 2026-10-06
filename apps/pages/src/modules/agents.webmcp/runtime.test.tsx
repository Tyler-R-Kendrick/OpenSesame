import { resetContributionsForTest } from "@opensesame/app-core/lib/contributions.js";
import { webmcpNavigationSeam } from "@opensesame/app-core/webmcp/navigation.js";
import { overlapCast } from "@opensesame/os-domain";
/** @vitest-environment jsdom */
import type { WebMcpToolDescriptor } from "@opensesame/webmcp";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { type ContextWithPorts, readOperationIds } from "../ports-b.js";
import {
  NO_SIDE_EFFECTS,
  expectLifecycle,
  importUnderSpies,
  runtimeOf,
} from "../runtime-test-kit.js";
import { createTestContext } from "../test-context.js";
import { registerWebMcpScope, webMcpSdkSeams } from "./registrar.js";
import type * as Runtime from "./runtime.js";

let runtime: typeof Runtime;

// The SDK is exclusive to this capability and must not be touched unless
// the capability is activated. The seam stands in for it and records any
// access, both to loading it and to its two entry points.
const sdk = {
  load: vi.fn(),
  detect: vi.fn(() => null),
  createRegistrar: vi.fn(() => ({ register: () => () => {} })),
};
const originalLoad = webMcpSdkSeams.load;

beforeAll(() => {
  webMcpSdkSeams.load = async () => {
    sdk.load();
    return overlapCast({
      detectModelContext: sdk.detect,
      createWebMcpRegistrar: sdk.createRegistrar,
    });
  };
});

afterAll(() => {
  webMcpSdkSeams.load = originalLoad;
});

describe("agents.webmcp runtime", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    sdk.load.mockClear();
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
    expect(sdk.load).not.toHaveBeenCalled();
    expect(sdk.detect).not.toHaveBeenCalled();
    expect(sdk.createRegistrar).not.toHaveBeenCalled();
  });

  it("registers the boot tools and the job, and disposes them (LOAD-09)", async () => {
    await expectLifecycle(runtimeOf(runtime), {
      capability: "agents.webmcp",
      kinds: ["background-job", "shell-wrapper", "webmcp-tool"],
      // three boot tools, the core's ten (vault metadata, password workflows and the reveal
      // ceremony) and the login draft, plus the registration job and the
      // session wrapper
      count: 3 + 10 + 1 + 1 + 1,
    });
  });

  it("tags each boot tool and leaves the SDK alone until the job starts", async () => {
    const t = createTestContext();
    const handle = await runtime.capabilityRuntime.activate(t.ctx);
    const tools = t.entries("webmcp-tool");
    // The three that describe the app itself, then the core's own — which
    // have no module of their own to be contributed from, and had no
    // registrar at all until this capability took them.
    expect(tools.map((tool) => tool.name).slice(0, 3)).toEqual([
      "opensesame_status",
      "opensesame_navigate",
      "opensesame_health",
    ]);
    expect(tools.map((tool) => readOperationIds(tool)?.[0])).toEqual(
      expect.arrayContaining([
        "app.status",
        "app.navigate",
        "host.health.pages",
      ]),
    );
    for (const name of [
      "opensesame_vault_search",
      "opensesame_vault_item_read",
      "opensesame_vault_item_write",
      "opensesame_totp_code",
      "opensesame_open_reveal",
      "opensesame_vault_find_references",
      "opensesame_vault_inventory",
      "opensesame_vault_audit_organization",
      "opensesame_vault_env_template",
      "opensesame_open_password_workflow",
    ]) {
      expect(tools.map((tool) => tool.name)).toContain(name);
    }
    // Every one carries its operations, or the core could not filter it.
    for (const tool of tools) {
      expect(readOperationIds(tool)?.[0]).toBeTruthy();
    }
    expect(t.entries("background-job").map((job) => job.id)).toEqual([
      "webmcp-boot",
    ]);
    expect(sdk.load).not.toHaveBeenCalled();
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
    const handle = await runtime.capabilityRuntime.activate(t.ctx);
    const record = t.registered.find((entry) => entry.kind === "shell-wrapper");
    expect(record?.entry).toMatchObject({ id: "webmcp-session", order: 20 });
    expect(t.liveKinds()).toContain("shell-wrapper");
    await handle.dispose();
    expect(t.liveKinds()).not.toContain("shell-wrapper");
    await handle.dispose();
    expect(record?.revokeCalls).toBe(1);
  });
  it("uses the real registrar against a browser API and revokes registered tools", async () => {
    const sdkLoads = vi
      .spyOn(webMcpSdkSeams, "load")
      .mockImplementation(originalLoad);
    const tools = new Map<string, WebMcpToolDescriptor>();
    vi.stubGlobal("navigator", {
      modelContext: {
        registerTool(tool: WebMcpToolDescriptor) {
          tools.set(tool.name, tool);
          return () => {
            tools.delete(tool.name);
          };
        },
      },
    });
    const t = createTestContext();
    const handle = await runtime.capabilityRuntime.activate(t.ctx);
    expect(sdkLoads).not.toHaveBeenCalled();
    const controller = new AbortController();
    const off = await registerWebMcpScope(
      "session",
      t.entries("webmcp-tool"),
      controller.signal,
    );
    expect(sdkLoads).toHaveBeenCalledOnce();
    expect([...tools.keys()]).toEqual(
      t.entries("webmcp-tool").map((tool) => tool.name),
    );
    expect(tools.has("opensesame_open_password_workflow")).toBe(true);
    off();
    expect(tools.size).toBe(0);
    off();
    await handle.dispose();
  });
});
