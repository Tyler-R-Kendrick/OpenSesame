/** @vitest-environment jsdom */
import {
  act,
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
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
import { slideZones } from "./vault/add-slide.js";
import "./vault/commands.test-support.js";
import { vaultTreeSeams } from "./vault/VaultTree.js";
import { makeAccount } from "./vault/section-items.test-support.js";

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

/** The one element `selector` names, narrowed by a check: absent fails the test. */
function drawn(selector: string): HTMLElement {
  const element = document.querySelector(selector);
  if (!(element instanceof HTMLElement)) {
    throw new Error(`nothing drawn at ${selector}`);
  }
  return element;
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
    vault.items = [makeAccount({ id: "itm_1", name: "GitHub" })];
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

  it("the tree is the sections and nothing else: no strip of keys, no tool rows", () => {
    renderVault("/vault");
    const tree = document.querySelector<HTMLElement>(".vault__tree");
    expect(tree?.querySelector(".vtree__pathbar")).toBeNull();
    expect(tree?.querySelector(".vtools")).toBeNull();
    expect(screen.queryByRole("button", { name: "Import items" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Export items" })).toBeNull();
  });

  it("Add is one button: a sharp + with no ellipsis and no button beside it", () => {
    renderVault("/vault");
    const add = drawn(".vault > .fab");
    const plus = within(add).getByRole("link", {
      name: "New item",
    });
    expect(plus.getAttribute("href")).toMatch(/^\/vault\/new/);
    expect(within(add).queryAllByRole("button")).toEqual([]);
    expect(
      screen.queryByRole("button", { name: "More ways to add" }),
    ).toBeNull();
  });

  it("keeps import and export in the hold zones and the keyboard menu", () => {
    renderVault("/vault");
    const plus = screen.getByRole("link", { name: "New item" });
    fireEvent.contextMenu(plus);
    expect(
      screen.getAllByRole("menuitem").map((entry) => entry.textContent),
    ).toEqual(["Import items", "Export items", "Open a claim"]);
    expect(slideZones().up?.id).toBe("import");
    expect(slideZones().down?.id).toBe("export");
  });

  it("the list's header is back and the view it shows, named; nothing else is a key", () => {
    renderVault("/vault?f=all");
    const bar = drawn(".vault__list .vtree__pathbar");
    const view = within(bar).getByRole("button", {
      name: /^Filter — /,
    });
    expect(view.textContent).toBe("All items");
    expect(
      within(bar).getByRole("link", {
        name: "Back to sections",
      }),
    ).toBeTruthy();
    // New is the corner button; Import and Export are on the landing; search
    // is the prompt. None is repeated in the header.
    for (const name of ["New item", "Import items", "Export items"]) {
      expect(bar.querySelector(`[aria-label="${name}"]`)).toBeNull();
    }
    expect(bar.querySelector('[title="Search (/)"]')).toBeNull();
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
    fireEvent.click(drawn('.vault__list [role="treeitem"]'));
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
    await waitFor(() => expect(prompt).toHaveProperty("value", "/? "));
    expect(document.activeElement).toBe(prompt);
    expect(screen.queryByLabelText("Search items")).toBeNull();
  });

  /** Types into the shell's one prompt, the way the `/` key and a keyboard do. */
  async function typeSearch(words: string): Promise<HTMLInputElement> {
    const handler = createKeymapHandler({
      navigate: vi.fn(),
      showHelp: vi.fn(),
    });
    act(() => handler(new KeyboardEvent("keydown", { key: "/" })));
    const prompt = screen.getByRole("combobox", { name: "Command" });
    if (!(prompt instanceof HTMLInputElement))
      throw new Error("the command prompt is not a text field");
    await waitFor(() => expect(prompt.value).toBe("/? "));
    fireEvent.change(prompt, { target: { value: `/? ${words}` } });
    return prompt;
  }

  it("a search typed on the list ends when the tree comes back, so all shows every item", async () => {
    renderVault("/vault?f=all");
    await act(async () => undefined);
    const prompt = await typeSearch("zzz");
    expect(screen.queryAllByText("GitHub")).toHaveLength(0);
    fireEvent.click(screen.getByRole("link", { name: "Back to sections" }));
    await waitFor(() => expect(pane()).toBe("tree"));
    await waitFor(() => expect(prompt.value).toBe(""));
    fireEvent.click(screen.getByRole("treeitem", { name: "all" }));
    await waitFor(() => expect(pane()).toBe("list"));
    expect(screen.getAllByText("GitHub").length).toBeGreaterThan(0);
  });

  it("an item opened from a search comes back to that same search", async () => {
    renderVault("/vault?f=all");
    await act(async () => undefined);
    const prompt = await typeSearch("git");
    // The match is highlighted, which splits the name across elements.
    const row = document.querySelector<HTMLElement>(
      '.vault__list [role="treeitem"]',
    );
    if (!row) throw new Error("the search matched no row");
    fireEvent.click(row);
    await waitFor(() => expect(pane()).toBe("detail"));
    fireEvent.click(screen.getByRole("link", { name: "Back to all items" }));
    await waitFor(() => expect(pane()).toBe("list"));
    expect(prompt.value).toBe("/? git");
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
    vault.items = [makeAccount({ id: "itm_1", name: "GitHub" })];
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
