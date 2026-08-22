import {
  type ComponentProps,
  type ReactNode,
  StrictMode,
  isValidElement,
} from "react";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RpApp } from "./RpApp.js";

type RpAppProps = ComponentProps<typeof RpApp>;

const renderMock = vi.fn<Root["render"]>();
const createRootMock = vi.fn<typeof import("./react-dom.js").createRoot>(
  () => ({
    render: renderMock,
    unmount: vi.fn(),
  }),
);

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
    const tree = renderMock.mock.calls[0]?.[0];
    if (!isValidElement<{ children?: ReactNode }>(tree)) {
      throw new Error("expected StrictMode element");
    }
    expect(tree.type).toBe(StrictMode);
    const app = tree.props.children;
    if (!isValidElement<RpAppProps>(app)) {
      throw new Error("expected RpApp element");
    }
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
