import { afterEach, describe, expect, it, vi } from "vitest";
import { type WebMcpToolDescriptor, detectModelContext } from "./detect.js";
import { type WebMcpToolSpec, createWebMcpRegistrar } from "./registrar.js";

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
  it("no-ops when no navigator.modelContext exists", () => {
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
});
