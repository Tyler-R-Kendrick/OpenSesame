/** @vitest-environment jsdom */
import { act, cleanup, screen, waitFor } from "@testing-library/react";
import { Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  registerContributedShell,
  renderShell,
  resetShellRender,
  vault,
} from "../components/app-shell.test-harness.js";
import { createKeymapHandler } from "../lib/keymap.js";
import { stubScreen } from "../lib/use-narrow.test-support.js";
import { vaultHooksSeams } from "../lib/vault/hooks.js";
import { VaultSection } from "./VaultSection.js";
import { ItemDetail } from "./vault/ItemDetail.js";
import { vaultTreeSeams } from "./vault/VaultTree.js";
import { makeLogin } from "./vault/section-items.test-support.js";

Object.assign(vaultHooksSeams, { useCopySecret: () => vi.fn() });
Object.assign(vaultTreeSeams, {
  activeTomb: () => "personal",
  loadCollapsed: async (): Promise<string[]> => [],
  saveCollapsed: async () => undefined,
});

/** The vault section inside the real shell, so the rail and the pane are both drawn. */
function renderVault(path: string) {
  return renderShell(
    path,
    <Routes>
      <Route path="/vault" element={<VaultSection />}>
        <Route index element={<div>welcome pane</div>} />
        <Route path=":itemId" element={<ItemDetail />} />
      </Route>
    </Routes>,
  );
}

const pane = () =>
  document.querySelector<HTMLElement>(".vault")?.getAttribute("data-pane");
const trees = () => screen.queryAllByRole("tree", { name: "Sections" });

describe("the vault on a phone", () => {
  let revoke: readonly (() => void)[] = [];
  beforeEach(() => {
    revoke = registerContributedShell();
    vault.items = [makeLogin({ id: "itm_1", name: "GitHub" })];
    vault.folders = [];
    stubScreen({ narrow: true, coarse: true });
  });
  afterEach(() => {
    resetShellRender();
    for (const undo of revoke) undo();
    vi.unstubAllGlobals();
  });

  it("opens on the one section tree, and the keyboard is on it", async () => {
    renderVault("/vault");
    expect(pane()).toBe("tree");
    // The rail is not drawn below the breakpoint: the vault pane carries the
    // tree, so two trees never share the page.
    expect(trees()).toHaveLength(1);
    await waitFor(() => expect(document.activeElement).toBe(trees()[0]));
  });

  it("a filter in the address is the list, with a key back to the tree", () => {
    renderVault("/vault?f=all");
    expect(pane()).toBe("list");
    const back = screen.getByRole("link", { name: "Back to sections" });
    expect(back.getAttribute("href")).toBe("/vault");
  });

  it("an item is the buffer, and Back returns to the list it came from", () => {
    renderVault("/vault/itm_1?f=login");
    expect(pane()).toBe("detail");
    expect(
      screen.getByRole("link", { name: "Back to list" }).getAttribute("href"),
    ).toBe("/vault?f=login");
  });

  it("an item reached with no filter goes back to the list of everything", () => {
    renderVault("/vault/itm_1");
    expect(
      screen
        .getByRole("link", { name: "Back to all items" })
        .getAttribute("href"),
    ).toBe("/vault?f=all");
  });

  it("the tree's row carries import and export; New is the corner button and search is the prompt", () => {
    renderVault("/vault");
    const row = document.querySelector<HTMLElement>(".vault__tree");
    expect(
      row?.querySelector('[aria-label="Export items"], [title="Export items"]'),
    ).not.toBeNull();
    // No New key and no search key in the row: neither is drawn twice.
    expect(row?.querySelector('[aria-label="New item"]')).toBeNull();
    expect(row?.querySelector('[title="Search (/)"]')).toBeNull();
    const fab = document.querySelector<HTMLAnchorElement>(".vault > .fab");
    expect(fab?.getAttribute("aria-label")).toBe("New item");
    expect(fab?.getAttribute("href")).toMatch(/^\/vault\/new/);
  });

  it("the corner button follows the tree and the list, and leaves the item and the trash alone", () => {
    renderVault("/vault?f=all");
    expect(document.querySelectorAll(".fab")).toHaveLength(1);
    cleanup();
    renderVault("/vault?f=trash");
    expect(document.querySelector(".fab")).toBeNull();
    cleanup();
    renderVault("/vault/itm_1?f=all");
    expect(document.querySelector(".fab")).toBeNull();
  });

  it("a search left in the address narrows the list and rides back from an item", () => {
    renderVault("/vault?f=all&q=git");
    expect(pane()).toBe("list");
    expect(screen.queryByRole("textbox", { name: /search/i })).toBeNull();
    expect(
      document.querySelector(".vault__status-meta")?.textContent,
    ).toContain("/git");
    cleanup();
    renderVault("/vault/itm_1?q=git");
    // A narrowed list is not "all items", so the key says "list".
    expect(
      screen.getByRole("link", { name: "Back to list" }).getAttribute("href"),
    ).toBe("/vault?q=git&f=all");
  });

  it("the / key writes the search verb into the real prompt rather than opening a box", async () => {
    renderVault("/vault?f=all");
    // The list focuses its rows once the saved collapse state has loaded.
    await act(async () => undefined);
    const handler = createKeymapHandler({
      navigate: vi.fn(),
      showHelp: vi.fn(),
    });
    act(() => handler(new KeyboardEvent("keydown", { key: "/" })));
    const prompt = screen.getByRole("combobox", { name: "Command" });
    await waitFor(() => expect((prompt as HTMLInputElement).value).toBe("/? "));
    expect(document.activeElement).toBe(prompt);
    expect(screen.queryByLabelText("Search items")).toBeNull();
  });

  it("the tree's all entry names the list, so tapping it leaves the tree", () => {
    renderVault("/vault");
    expect(
      screen.getByRole("treeitem", { name: "all" }).getAttribute("href"),
    ).toBe("/vault?f=all");
  });
});

describe("the vault on a desktop", () => {
  let revoke: readonly (() => void)[] = [];
  beforeEach(() => {
    revoke = registerContributedShell();
    vault.items = [makeLogin({ id: "itm_1", name: "GitHub" })];
    vault.folders = [];
    stubScreen({ narrow: false, coarse: false });
  });
  afterEach(() => {
    cleanup();
    resetShellRender();
    for (const undo of revoke) undo();
    vi.unstubAllGlobals();
  });

  it("has one tree, the rail's, and none in the vault pane", () => {
    renderVault("/vault");
    expect(trees()).toHaveLength(1);
    expect(document.querySelector(".vault__tree [role='tree']")).toBeNull();
  });

  it("an item goes back to the vault itself", () => {
    renderVault("/vault/itm_1");
    expect(
      screen
        .getByRole("link", { name: "Back to all items" })
        .getAttribute("href"),
    ).toBe("/vault");
  });
});
