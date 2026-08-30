import { afterEach, describe, expect, it, vi } from "vitest";
import { type WebMcpToolDescriptor, detectModelContext } from "./detect.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

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
});
