import {
  type ComponentProps,
  type ReactNode,
  StrictMode,
  isValidElement,
} from "react";
import type { Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
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
  // The first import of the entry transforms RpApp and its dependencies cold.
  // On a loaded runner that one-time cost alone can pass the 5s test timeout,
  // so it is paid here, under its own budget; the tests then measure the
  // mount, not the transform. `resetModules` below re-evaluates modules but
  // keeps their transforms.
  beforeAll(async () => {
    await import("./RpApp.js");
    await import("./react-dom.js");
  }, 60_000);

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
