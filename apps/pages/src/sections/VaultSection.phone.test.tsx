/** @vitest-environment jsdom */
import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
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
import "./vault/commands.test-support.js";
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

  it("the tree carries Import and Export as labelled rows, and no strip of keys", () => {
    renderVault("/vault");
    const tools = screen.getByRole("region", { name: "Vault tools" });
    for (const name of ["Import items", "Export items"]) {
      const row = within(tools).getByRole("button", { name });
      // A word on the face, not a glyph a person has to decode.
      expect(row.textContent).toBe(name);
      expect(row.querySelector("svg")).not.toBeNull();
    }
    const tree = document.querySelector<HTMLElement>(".vault__tree");
    expect(tree?.querySelector(".vtree__pathbar")).toBeNull();
    expect(tree?.querySelector('[aria-label="New item"]')).toBeNull();
    const fab = document.querySelector<HTMLAnchorElement>(".vault > .fab");
    expect(fab?.getAttribute("aria-label")).toBe("New item");
    expect(fab?.getAttribute("href")).toMatch(/^\/vault\/new/);
  });

  it("the list's header is back and the view it shows, named; nothing else is a key", () => {
    renderVault("/vault?f=all");
    const bar = document.querySelector<HTMLElement>(
      ".vault__list .vtree__pathbar",
    );
    const view = within(bar as HTMLElement).getByRole("button", {
      name: /^Filter — /,
    });
    expect(view.textContent).toBe("All items");
    expect(
      within(bar as HTMLElement).getByRole("link", {
        name: "Back to sections",
      }),
    ).toBeTruthy();
    // New is the corner button; Import and Export are on the landing; search
    // is the prompt. None is repeated in the header.
    for (const name of ["New item", "Import items", "Export items"]) {
      expect(
        (bar as HTMLElement).querySelector(`[aria-label="${name}"]`),
      ).toBeNull();
    }
    expect(
      (bar as HTMLElement).querySelector('[title="Search (/)"]'),
    ).toBeNull();
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
