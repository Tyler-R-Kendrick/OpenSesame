import { cleanup, render, screen, waitFor } from "@testing-library/react";
/** @vitest-environment jsdom */
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeLogin } from "./vault/section-items.test-support.js";

import { vaultHooksSeams } from "../lib/vault/hooks.js";
import { vaultTreeSeams } from "./vault/VaultTree.js";

// The rail's tree has its own suite; here it is a stand-in, so what is under
// test is which pane the vault shows and where each way back goes.
vi.mock("../components/NavTree.js", () => ({
  NavTree: () => (
    // biome-ignore lint/a11y/noNoninteractiveTabindex: the real tree is role=tree with the tab stop on it
    <nav role="tree" aria-label="Sections" tabIndex={0} />
  ),
}));

const item = makeLogin({ id: "itm_1", name: "GitHub" });
Object.assign(vaultHooksSeams, {
  useVault: () => ({ items: [item], folders: [], header: null }),
  useVaultStore: () => ({}),
  useCopySecret: () => vi.fn(),
});
Object.assign(vaultTreeSeams, {
  activeTomb: () => "personal",
  loadCollapsed: async (): Promise<string[]> => [],
  saveCollapsed: async () => undefined,
});

import { VaultSection } from "./VaultSection.js";
import { ItemDetail } from "./vault/ItemDetail.js";

function phone(narrow: boolean) {
  vi.stubGlobal(
    "matchMedia",
    (query: string) =>
      ({
        matches: narrow && query.includes("max-width: 900px"),
        media: query,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      }) as unknown as MediaQueryList,
  );
}

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/vault" element={<VaultSection />}>
          <Route index element={<div>welcome pane</div>} />
          <Route path=":itemId" element={<ItemDetail />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

const pane = () =>
  document.querySelector<HTMLElement>(".vault")?.getAttribute("data-pane");

describe("the vault on a phone", () => {
  beforeEach(() => phone(true));
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("opens on the section tree, not on a list", async () => {
    renderAt("/vault");
    expect(pane()).toBe("tree");
    expect(screen.getByRole("tree", { name: "Sections" })).toBeTruthy();
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole("tree", { name: "Sections" }),
      ),
    );
  });

  it("a filter in the address is the list, with a key back to the tree", () => {
    renderAt("/vault?f=all");
    expect(pane()).toBe("list");
    const back = screen.getByRole("link", { name: "Back to sections" });
    expect(back.getAttribute("href")).toBe("/vault");
  });

  it("an item is the buffer, and Back returns to the list it came from", () => {
    renderAt("/vault/itm_1?f=login");
    expect(pane()).toBe("detail");
    expect(
      screen.getByRole("link", { name: "Back to list" }).getAttribute("href"),
    ).toBe("/vault?f=login");
  });

  it("an item reached with no filter goes back to the list of everything", () => {
    renderAt("/vault/itm_1");
    expect(
      screen
        .getByRole("link", { name: "Back to all items" })
        .getAttribute("href"),
    ).toBe("/vault?f=all");
  });
});

describe("the vault on a desktop", () => {
  beforeEach(() => phone(false));
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("draws no tree of its own: the rail carries it", () => {
    renderAt("/vault");
    expect(screen.queryByRole("tree", { name: "Sections" })).toBeNull();
  });

  it("an item goes back to the vault itself", () => {
    renderAt("/vault/itm_1");
    expect(
      screen
        .getByRole("link", { name: "Back to all items" })
        .getAttribute("href"),
    ).toBe("/vault");
  });
});
