/** @vitest-environment jsdom */
import {
  act,
  cleanup,
  fireEvent,
  screen,
  waitFor,
} from "@testing-library/react";
import { Route, Routes, useNavigationType } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  registerContributedShell,
  renderShell,
  resetShellRender,
  vault,
} from "../components/app-shell.test-harness.js";
import { ContextMenuLayer } from "../components/context-menu/ContextMenuLayer.js";
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
    <>
      <ContextMenuLayer />
      <Routes>
        <Route
          path="/vault"
          element={
            <>
              <VaultSection />
              <Arrival />
            </>
          }
        >
          <Route index element={<div>welcome pane</div>} />
          <Route path=":itemId" element={<ItemDetail />} />
        </Route>
      </Routes>
    </>,
  );
}

/** Says how the current entry was arrived at, for the tests to read. */
function Arrival() {
  return <output data-testid="arrival">{useNavigationType()}</output>;
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

  it("the tree opens on the sections and one Add key; the keys of the desktop's row and any search field are not drawn", () => {
    renderVault("/vault");
    const tree = document.querySelector<HTMLElement>(".vault__tree");
    // Finding is the status-line prompt: the pane draws no field of its own.
    expect(tree?.querySelector(".vadd__find")).toBeNull();
    expect(tree?.querySelectorAll(".vadd__key")).toHaveLength(1);
    expect(tree?.querySelector(".vtree__keys")).toBeNull();
    // Import and Export stay mounted for the sheets they own, but as no key.
    const hidden = tree?.querySelectorAll(".vadd__host > button") ?? [];
    expect(hidden.length).toBeGreaterThan(0);
  });

  it("the Add key opens the action sheet: New item, then Import and Export", async () => {
    renderVault("/vault");
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    const menu = await screen.findByRole("menu", { name: "Add to the vault" });
    const rows = [...menu.querySelectorAll('[role="menuitem"]')].map((row) =>
      row.getAttribute("aria-label"),
    );
    // Whatever a capability adds (Import) sits between the two ends.
    expect(rows[0]).toBe("New item");
    expect(rows.at(-1)).toBe("Export items");
    // A row presses the key of the command it stands for.
    const key = document.querySelector<HTMLElement>(
      '.vadd__host > [aria-label="Export items"]',
    );
    const pressed = vi.fn((event: Event) => event.stopImmediatePropagation());
    key?.addEventListener("click", pressed);
    fireEvent.click(screen.getByRole("menuitem", { name: "Export items" }));
    expect(pressed).toHaveBeenCalledOnce();
  });

  it("New item in the sheet opens the editor", async () => {
    renderVault("/vault");
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "New item" }));
    await waitFor(() => expect(pane()).toBe("detail"));
    expect(screen.queryByRole("menu", { name: "Add to the vault" })).toBeNull();
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

  it("the Back keys pop the history, so the system Back button is not sent back in", async () => {
    renderVault("/vault");
    await act(async () => undefined);
    fireEvent.click(screen.getByRole("treeitem", { name: "all" }));
    await waitFor(() => expect(pane()).toBe("list"));
    expect(screen.getByTestId("arrival").textContent).toBe("PUSH");
    fireEvent.click(screen.getByRole("link", { name: "Back to sections" }));
    await waitFor(() => expect(pane()).toBe("tree"));
    expect(screen.getByTestId("arrival").textContent).toBe("POP");
    fireEvent.click(screen.getByRole("treeitem", { name: "all" }));
    await waitFor(() => expect(pane()).toBe("list"));
    fireEvent.click(
      document.querySelector('.vault__list [role="treeitem"]') as HTMLElement,
    );
    await waitFor(() => expect(pane()).toBe("detail"));
    fireEvent.click(screen.getByRole("link", { name: "Back to all items" }));
    await waitFor(() => expect(pane()).toBe("list"));
    expect(screen.getByTestId("arrival").textContent).toBe("POP");
  });

  it("a link into the middle replaces on the way up, since nothing is below it", async () => {
    renderVault("/vault?f=all");
    await act(async () => undefined);
    fireEvent.click(screen.getByRole("link", { name: "Back to sections" }));
    await waitFor(() => expect(pane()).toBe("tree"));
    expect(screen.getByTestId("arrival").textContent).toBe("REPLACE");
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
