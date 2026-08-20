import { StrictMode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { overlapCast } from "@opensesame/os-domain";

const renderMock = vi.fn();
const createRootMock = vi.fn(() => ({ render: renderMock }));

describe("main entrypoint", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
    renderMock.mockClear();
    createRootMock.mockClear();
  });

  it("mounts the beta relying party into the #root element", async () => {
    const { reactDomSeams } = await import("./react-dom.js");
    reactDomSeams.createRoot = createRootMock;
    const rootEl = { id: "root" };
    const getElementById = vi.fn(() => rootEl);
    vi.stubGlobal("document", { getElementById });

    await import("./main.js");

    expect(getElementById).toHaveBeenCalledWith("root");
    expect(createRootMock).toHaveBeenCalledWith(rootEl);
    expect(renderMock).toHaveBeenCalledTimes(1);
    const tree = overlapCast(renderMock.mock.calls[0]?.[0]);
    expect(tree.type).toBe(StrictMode);
    const app = overlapCast(tree.props.children);
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
