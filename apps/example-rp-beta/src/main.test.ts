import { StrictMode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const renderMock = vi.fn();
const createRootMock = vi.fn(() => ({ render: renderMock }));

vi.mock("react-dom/client", () => ({
  createRoot: createRootMock,
}));

type TestElement = { type: unknown; props: Record<string, unknown> };

describe("main entrypoint", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
    renderMock.mockClear();
    createRootMock.mockClear();
  });

  it("mounts the beta relying party into the #root element", async () => {
    const rootEl = { id: "root" };
    const getElementById = vi.fn(() => rootEl);
    vi.stubGlobal("document", { getElementById });

    await import("./main.js");

    expect(getElementById).toHaveBeenCalledWith("root");
    expect(createRootMock).toHaveBeenCalledWith(rootEl);
    expect(renderMock).toHaveBeenCalledTimes(1);
    const tree = renderMock.mock.calls[0]?.[0] as TestElement;
    expect(tree.type).toBe(StrictMode);
    const app = tree.props.children as TestElement;
    expect(app.props).toMatchObject({
      name: "RP Beta",
      clientId: "rp-beta",
      sector: "https://beta.example.test",
      port: 5175,
    });
  });

  it("throws when the #root element is missing", async () => {
    vi.stubGlobal("document", { getElementById: () => null });
    await expect(import("./main.js")).rejects.toThrow("missing #root");
  });
});
