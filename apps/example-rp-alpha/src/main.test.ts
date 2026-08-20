import { overlapCast } from "@opensesame/os-domain";
/** @vitest-environment jsdom */
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = {
  createRoot: vi.fn(),
  render: vi.fn(),
};

beforeEach(async () => {
  vi.clearAllMocks();
  vi.resetModules();
  mocks.createRoot.mockReturnValue({ render: mocks.render });
  const { reactDomSeams } = await import("./react-dom.js");
  reactDomSeams.createRoot = mocks.createRoot;
  document.body.innerHTML = "";
});

afterEach(() => {
  document.body.innerHTML = "";
});

describe("main entrypoint", () => {
  it("throws when the #root element is missing", async () => {
    await expect(import("./main.js")).rejects.toThrow("missing #root");
    expect(mocks.createRoot).not.toHaveBeenCalled();
  });

  it("mounts RpApp in StrictMode with the alpha relying-party config", async () => {
    const host = document.createElement("div");
    host.id = "root";
    document.body.appendChild(host);

    await import("./main.js");

    expect(mocks.createRoot).toHaveBeenCalledWith(host);
    expect(mocks.render).toHaveBeenCalledOnce();

    const tree = overlapCast(mocks.render.mock.calls[0]?.[0]);
    expect(tree.type).toBe(StrictMode);
    expect(tree.props.children.props).toMatchObject({
      name: "RP Alpha",
      clientId: "rp-alpha",
      sector: "https://alpha.example.test",
      port: 5174,
    });
  });
});
