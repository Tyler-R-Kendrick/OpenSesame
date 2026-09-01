import type { JsonObject } from "@opensesame/os-domain";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type WebMcpToolDescriptor, detectModelContext } from "./detect.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

function descriptor(name = "opensesame_x"): WebMcpToolDescriptor {
  return {
    name,
    description: name,
    inputSchema: {},
    execute: async () => ({ content: [] }),
  };
}

/**
 * Every method records the receiver it was invoked on, so a method that the
 * detector failed to bind shows up as a wrong (or throwing) host rather than
 * as a silently passing call.
 */
function fakeModelContext(host: string) {
  const calls: string[] = [];
  const tools: WebMcpToolDescriptor[] = [];
  return {
    host,
    calls,
    tools,
    registerTool(tool: WebMcpToolDescriptor) {
      calls.push(`${this.host}:register:${tool.name}`);
      tools.push(tool);
      return {
        unregister: () => {
          calls.push(`${host}:unregister:${tool.name}`);
        },
      };
    },
    getTools() {
      calls.push(`${this.host}:getTools`);
      return tools;
    },
    executeTool(name: string, args: JsonObject) {
      calls.push(`${this.host}:execute:${name}`);
      return { name, args };
    },
  };
}

describe("detectModelContext", () => {
  it("returns null when there is no navigator at all", () => {
    vi.stubGlobal("navigator", undefined);
    expect(detectModelContext()).toBeNull();
  });

  it("returns null when navigator has no modelContext", () => {
    vi.stubGlobal("navigator", {});
    expect(detectModelContext()).toBeNull();
  });

  it("returns null when modelContext exposes no usable method", () => {
    vi.stubGlobal("navigator", { modelContext: { registerTool: 42 } });
    expect(detectModelContext()).toBeNull();
  });

  it("binds registerTool to the modelContext object", () => {
    const seen: WebMcpToolDescriptor[] = [];
    const modelContext = {
      registered: seen,
      registerTool(tool: WebMcpToolDescriptor) {
        this.registered.push(tool);
        return () => {};
      },
    };
    vi.stubGlobal("navigator", { modelContext });
    const api = detectModelContext();
    expect(api?.provideContext).toBeUndefined();
    api?.registerTool?.({
      name: "opensesame_x",
      description: "x",
      inputSchema: {},
      execute: async () => ({ content: [] }),
    });
    expect(seen).toHaveLength(1);
  });

  it("detects a provideContext-only implementation", () => {
    const provideContext = vi.fn();
    vi.stubGlobal("navigator", { modelContext: { provideContext } });
    const api = detectModelContext();
    expect(api?.registerTool).toBeUndefined();
    api?.provideContext?.({ tools: [] });
    expect(provideContext).toHaveBeenCalledWith({ tools: [] });
  });

  it("detects document.modelContext and binds its methods to it", () => {
    const documentContext = fakeModelContext("document");
    vi.stubGlobal("document", { modelContext: documentContext });
    vi.stubGlobal("navigator", {});
    const api = detectModelContext();
    expect(api?.source).toBe("document");
    api?.registerTool?.(descriptor());
    expect(documentContext.calls).toEqual(["document:register:opensesame_x"]);
  });

  it("reports the navigator source when only the legacy location exists", () => {
    const navigatorContext = fakeModelContext("navigator");
    vi.stubGlobal("document", {});
    vi.stubGlobal("navigator", { modelContext: navigatorContext });
    const api = detectModelContext();
    expect(api?.source).toBe("navigator");
    api?.registerTool?.(descriptor());
    expect(navigatorContext.calls).toEqual(["navigator:register:opensesame_x"]);
  });

  it("prefers document over navigator when both are present", () => {
    const documentContext = fakeModelContext("document");
    const navigatorContext = fakeModelContext("navigator");
    vi.stubGlobal("document", { modelContext: documentContext });
    vi.stubGlobal("navigator", { modelContext: navigatorContext });
    const api = detectModelContext();
    expect(api?.source).toBe("document");
    api?.registerTool?.(descriptor());
    expect(documentContext.tools).toHaveLength(1);
    expect(navigatorContext.calls).toEqual([]);
  });

  it("returns null when neither location exposes modelContext", () => {
    vi.stubGlobal("document", {});
    vi.stubGlobal("navigator", {});
    expect(detectModelContext()).toBeNull();
  });

  it("returns null for a document.modelContext with no usable method", () => {
    vi.stubGlobal("document", { modelContext: { registerTool: "nope" } });
    vi.stubGlobal("navigator", {});
    expect(detectModelContext()).toBeNull();
  });

  it("keeps a working legacy object when the document one is a stub", () => {
    const navigatorContext = fakeModelContext("navigator");
    vi.stubGlobal("document", { modelContext: { registerTool: null } });
    vi.stubGlobal("navigator", { modelContext: navigatorContext });
    const api = detectModelContext();
    expect(api?.source).toBe("navigator");
    api?.registerTool?.(descriptor());
    expect(navigatorContext.tools).toHaveLength(1);
  });

  it("binds getTools and executeTool to the modelContext object", () => {
    const documentContext = fakeModelContext("document");
    vi.stubGlobal("document", { modelContext: documentContext });
    const api = detectModelContext();
    api?.registerTool?.(descriptor());
    expect(api?.getTools?.()).toHaveLength(1);
    api?.executeTool?.("opensesame_x", { a: 1 });
    expect(documentContext.calls).toEqual([
      "document:register:opensesame_x",
      "document:getTools",
      "document:execute:opensesame_x",
    ]);
  });
});
