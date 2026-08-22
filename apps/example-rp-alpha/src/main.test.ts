/** @vitest-environment jsdom */
import {
  type ComponentProps,
  type ReactNode,
  StrictMode,
  isValidElement,
} from "react";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RpApp } from "./RpApp.js";

type RpAppProps = ComponentProps<typeof RpApp>;

const mocks = {
  createRoot: vi.fn<typeof import("./react-dom.js").createRoot>(),
  render: vi.fn<Root["render"]>(),
  unmount: vi.fn<Root["unmount"]>(),
};

beforeEach(async () => {
  vi.clearAllMocks();
  vi.resetModules();
  mocks.createRoot.mockReturnValue({
    render: mocks.render,
    unmount: mocks.unmount,
  });
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

    const tree = mocks.render.mock.calls[0]?.[0];
    if (!isValidElement<{ children?: ReactNode }>(tree)) {
      throw new Error("expected StrictMode element");
    }
    expect(tree.type).toBe(StrictMode);
    const app = tree.props.children;
    if (!isValidElement<RpAppProps>(app)) {
      throw new Error("expected RpApp element");
    }
    expect(app.props).toMatchObject({
      name: "RP Alpha",
      clientId: "rp-alpha",
      sector: "https://alpha.example.test",
      port: 5174,
    });
  });
});
