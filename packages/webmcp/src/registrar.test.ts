import type { JsonObject } from "@opensesame/os-domain";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type ModelContextApi,
  type WebMcpToolDescriptor,
  detectModelContext,
} from "./detect.js";
import {
  type WebMcpToolSpec,
  createWebMcpRegistrar,
  listRegisteredTools,
  toolDisposition,
} from "./registrar.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

function spec(overrides: Partial<WebMcpToolSpec> = {}): WebMcpToolSpec {
  return {
    name: "opensesame_status",
    description: "status",
    inputSchema: { type: "object", properties: {} },
    execute: () => ({ ok: true }),
    ...overrides,
  };
}

describe("createWebMcpRegistrar", () => {
  it("no-ops when neither document nor navigator exposes modelContext", () => {
    vi.stubGlobal("document", {});
    vi.stubGlobal("navigator", {});
    const registrar = createWebMcpRegistrar(detectModelContext(), {
      appId: "pages",
    });
    const unregister = registrar.register([spec()]);
    expect(unregister).toBeInstanceOf(Function);
    unregister();
  });

  it("rejects names without the opensesame_ prefix even without an API", () => {
    const registrar = createWebMcpRegistrar(null, { appId: "pages" });
    expect(() => registrar.register([spec({ name: "vault_read" })])).toThrow(
      /webmcp_tool_prefix_required:pages:vault_read/,
    );
  });

  it("rejects secret-shaped names via the registry denylist", () => {
    const registrar = createWebMcpRegistrar(null, { appId: "pages" });
    expect(() =>
      registrar.register([spec({ name: "opensesame_get_secret" })]),
    ).toThrow("secret_tools_forbidden");
  });

  it("registers wrapped tools and unregisters via returned handles", async () => {
    const registered: WebMcpToolDescriptor[] = [];
    const unregistered: string[] = [];
    const api = {
      registerTool: (tool: WebMcpToolDescriptor) => {
        registered.push(tool);
        return { unregister: () => unregistered.push(tool.name) };
      },
    };
    const registrar = createWebMcpRegistrar(api, { appId: "pages" });
    const unregister = registrar.register([
      spec(),
      spec({ name: "opensesame_health", execute: () => "healthy" }),
    ]);
    expect(registered.map((tool) => tool.name)).toEqual([
      "opensesame_status",
      "opensesame_health",
    ]);

    const first = registered[0];
    const second = registered[1];
    if (!first || !second) throw new Error("registration missing");
    await expect(first.execute({})).resolves.toEqual({
      content: [{ type: "text", text: '{"ok":true}' }],
    });
    await expect(second.execute({})).resolves.toEqual({
      content: [{ type: "text", text: "healthy" }],
    });

    unregister();
    unregister();
    expect(unregistered).toEqual(["opensesame_status", "opensesame_health"]);
  });

  it("supports function-shaped unregister handles", () => {
    const calls: string[] = [];
    const api = {
      registerTool: (tool: WebMcpToolDescriptor) => () => calls.push(tool.name),
    };
    const registrar = createWebMcpRegistrar(api, { appId: "pages" });
    registrar.register([spec()])();
    expect(calls).toEqual(["opensesame_status"]);
  });

  it("falls back to provideContext and clears tools on unregister", () => {
    const provided: { tools: unknown[] | undefined }[] = [];
    const api = {
      provideContext: (context: { tools?: WebMcpToolDescriptor[] }) => {
        provided.push({ tools: context.tools });
        return undefined;
      },
    };
    const registrar = createWebMcpRegistrar(api, { appId: "pages" });
    const unregister = registrar.register([spec()]);
    expect(provided[0]?.tools).toHaveLength(1);
    unregister();
    expect(provided[1]?.tools).toHaveLength(0);
  });

  it("returns isError text without raw Error internals", async () => {
    const registered: WebMcpToolDescriptor[] = [];
    const api = {
      registerTool: (tool: WebMcpToolDescriptor) => void registered.push(tool),
    };
    const registrar = createWebMcpRegistrar(api, { appId: "pages" });
    registrar.register([
      spec({
        execute: () => {
          throw new Error("vault is locked\n  at secretFrame (internal)");
        },
      }),
      spec({
        name: "opensesame_health",
        execute: () => {
          throw new Error('leaks a "refresh_token" value');
        },
      }),
      spec({
        name: "opensesame_navigate",
        execute: () => {
          throw { not: "an error" };
        },
      }),
    ]);
    const [first, second, third] = registered;
    if (!first || !second || !third) throw new Error("registration missing");
    await expect(first.execute({})).resolves.toEqual({
      isError: true,
      content: [{ type: "text", text: "vault is locked" }],
    });
    await expect(second.execute({})).resolves.toEqual({
      isError: true,
      content: [{ type: "text", text: "tool_failed" }],
    });
    await expect(third.execute({})).resolves.toEqual({
      isError: true,
      content: [{ type: "text", text: "tool_failed" }],
    });
  });

  it("refuses results that still look like credentials", async () => {
    const registered: WebMcpToolDescriptor[] = [];
    const api = {
      registerTool: (tool: WebMcpToolDescriptor) => void registered.push(tool),
    };
    createWebMcpRegistrar(api, { appId: "pages" }).register([
      spec({ execute: () => ({ access_token: "abc" }) }),
    ]);
    const tool = registered[0];
    if (!tool) throw new Error("registration missing");
    await expect(tool.execute({})).resolves.toEqual({
      isError: true,
      content: [{ type: "text", text: "secret_in_agent_payload" }],
    });
  });

  it("registers through document.modelContext and detaches from it once", () => {
    const registered: string[] = [];
    const removed: string[] = [];
    const legacy: string[] = [];
    vi.stubGlobal("document", {
      modelContext: {
        registerTool(tool: WebMcpToolDescriptor) {
          registered.push(tool.name);
          return {
            unregister: () => {
              removed.push(tool.name);
            },
          };
        },
      },
    });
    vi.stubGlobal("navigator", {
      modelContext: {
        registerTool: (tool: WebMcpToolDescriptor) => legacy.push(tool.name),
      },
    });

    const unregister = createWebMcpRegistrar(detectModelContext(), {
      appId: "pages",
    }).register([spec()]);
    expect(registered).toEqual(["opensesame_status"]);
    expect(legacy).toEqual([]);
    unregister();
    unregister();
    expect(removed).toEqual(["opensesame_status"]);
  });
});

describe("toolDisposition", () => {
  it("defaults to discoverable and preserves a declared disposition", () => {
    expect(toolDisposition(spec())).toBe("discoverable");
    expect(toolDisposition(spec({ disposition: "tutorial_safe" }))).toBe(
      "tutorial_safe",
    );
    expect(toolDisposition(spec({ disposition: "human_required" }))).toBe(
      "human_required",
    );
  });

  it("does not change how a tool is registered", () => {
    const registered: WebMcpToolDescriptor[] = [];
    const api: ModelContextApi = {
      registerTool: (tool) => void registered.push(tool),
    };
    createWebMcpRegistrar(api, { appId: "pages" }).register([
      spec({ disposition: "human_required" }),
    ]);
    expect(registered.map((tool) => tool.name)).toEqual(["opensesame_status"]);
  });
});

describe("listRegisteredTools", () => {
  function platformApi(executed: string[]): ModelContextApi {
    return {
      source: "document",
      getTools: () => [
        {
          name: "opensesame_status",
          description: "status",
          inputSchema: { type: "object" },
          execute: () => ({ ok: true }),
        },
        { name: "opensesame_health" },
        { name: 7 },
        "not-a-tool",
        null,
      ],
      executeTool: (name: string, args: JsonObject) => {
        executed.push(name);
        return args;
      },
    };
  }

  it("returns metadata for every tool the browser reports", () => {
    const executed: string[] = [];
    const summaries = listRegisteredTools(platformApi(executed));
    expect(summaries).toEqual([
      {
        name: "opensesame_status",
        description: "status",
        inputSchema: { type: "object" },
      },
      { name: "opensesame_health", description: "", inputSchema: {} },
    ]);
    expect(summaries[0]).not.toHaveProperty("execute");
    expect(executed).toEqual([]);
  });

  it("returns an empty list without an api or without getTools", () => {
    expect(listRegisteredTools(null)).toEqual([]);
    expect(listRegisteredTools({ source: "navigator" })).toEqual([]);
    expect(listRegisteredTools({ getTools: () => "unexpected" })).toEqual([]);
  });

  it("reads through a detected document.modelContext", () => {
    vi.stubGlobal("document", {
      modelContext: {
        tools: [{ name: "opensesame_status", description: "status" }],
        getTools() {
          return this.tools;
        },
      },
    });
    expect(listRegisteredTools(detectModelContext())).toEqual([
      { name: "opensesame_status", description: "status", inputSchema: {} },
    ]);
  });
});
