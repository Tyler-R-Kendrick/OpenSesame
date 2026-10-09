import { registerLegacyItemKinds } from "@opensesame/app-core/lib/contributions.test-support.js";
import type { JsonObject } from "@opensesame/os-domain";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
/** @vitest-environment jsdom */
import {
  MemoryRouter,
  Route,
  Routes,
  useLocation,
  useNavigate,
  useNavigationType,
} from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { expectVaultCommands } from "./vault/commands.test-support.js";
import {
  makeAccount,
  makeDrop,
  makeNote,
} from "./vault/section-items.test-support.js";

import type {
  AccountItem,
  DropItem,
  Folder,
  NoteItem,
} from "@opensesame/vault-core";
import { createKeymapHandler } from "../lib/keymap.js";

type VaultHarness = {
  current: {
    items: Array<AccountItem | NoteItem | DropItem>;
    folders: Folder[];
    header: JsonObject | null;
  };
};

const vault: VaultHarness = {
  current: {
    items: [],
    folders: [],
    header: null,
  },
};

import { vaultHooksSeams } from "../lib/vault/hooks.js";
import { vaultTreeSeams } from "./vault/VaultTree.js";
const copySecret = vi.fn();
const store = {
  purgeItem: vi.fn(),
  trashItem: vi.fn(),
  toggleFavorite: vi.fn(),
};
const saveCollapsed = vi.fn(async () => undefined);
Object.assign(vaultHooksSeams, {
  useVault: () => vault.current,
  useVaultStore: () => store,
  useCopySecret: () => copySecret,
});
Object.assign(vaultTreeSeams, {
  activeTomb: () => "personal",
  loadCollapsed: async (): Promise<string[]> => [],
  saveCollapsed,
});

import { VaultSection, VaultWelcome } from "./VaultSection.js";

function renderWelcome() {
  return render(
    <MemoryRouter>
      <VaultWelcome />
    </MemoryRouter>,
  );
}

function renderSection(initial = "/vault") {
  return render(
    <MemoryRouter initialEntries={[initial]}>
      <Routes>
        <Route path="/vault" element={<VaultSection />}>
          <Route index element={<div>welcome pane</div>} />
          <Route path=":itemId" element={<div>detail pane</div>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

function keymap() {
  return createKeymapHandler({ navigate: vi.fn(), showHelp: vi.fn() });
}

function press(handler: (event: KeyboardEvent) => void, key: string) {
  act(() => {
    handler(
      new KeyboardEvent("keydown", {
        key,
        cancelable: true,
        shiftKey: key.length === 1 && key !== key.toLowerCase(),
      }),
    );
  });
}

function cursorRow(): HTMLElement {
  const row = screen
    .getAllByRole("treeitem")
    .find((candidate) => candidate.getAttribute("aria-selected") === "true");
  if (!row) throw new Error("No cursor row.");
  return row;
}

/** Registers the item kinds this suite's filters name (SURFACE-08). */
let revokeItemKinds: () => void;

describe("VaultSection", () => {
  beforeEach(() => {
    revokeItemKinds = registerLegacyItemKinds();
    vault.current = { items: [], folders: [], header: null };
    vaultTreeSeams.loadCollapsed = async () => [];
  });

  afterEach(() => {
    revokeItemKinds();
    cleanup();
    vi.clearAllMocks();
  });

  it("shows the empty state with new and import actions", () => {
    renderSection();
    expect(screen.getByText("Nothing here")).toBeTruthy();
    expect(
      screen.getByText(/Try the keyboard — n new, \/ search/),
    ).toBeTruthy();
    expect(
      screen.getByRole("link", { name: /New item/i }).getAttribute("href"),
    ).toBe("/vault/new");
    expectVaultCommands();
  });

  it("lists items as files with kind extensions and a status line", () => {
    vault.current = {
      items: [makeAccount(), makeNote()],
      folders: [],
      header: null,
    };
    renderSection();
    const rows = screen.getAllByRole("treeitem");
    expect(rows.map((row) => row.textContent)).toEqual([
      "Scratch pad.note",
      "Webmail.account",
    ]);
    expect(screen.getByText(/2\/2 · All items/)).toBeTruthy();
  });

  it("owns a visible cursor that the keymap moves", () => {
    vault.current = {
      items: [makeAccount(), makeNote()],
      folders: [],
      header: null,
    };
    renderSection();
    const handler = keymap();
    // The cursor lands on the first row without any input.
    expect(cursorRow().textContent).toBe("Scratch pad.note");
    press(handler, "j");
    expect(cursorRow().textContent).toBe("Webmail.account");
    // The status line follows the cursor with the tomb-rooted path.
    expect(screen.getByText("personal:/Webmail.account")).toBeTruthy();
    press(handler, "k");
    expect(cursorRow().textContent).toBe("Scratch pad.note");
    press(handler, "G");
    expect(cursorRow().textContent).toBe("Webmail.account");
    press(handler, "g");
    press(handler, "g");
    expect(cursorRow().textContent).toBe("Scratch pad.note");
  });

  it("repeats j by a vim count", () => {
    vault.current = {
      items: [
        makeNote({ id: "a", name: "A note" }),
        makeAccount({ id: "b", name: "B mail" }),
        makeNote({ id: "c", name: "C pad" }),
        makeAccount({ id: "d", name: "D web" }),
        makeNote({ id: "e", name: "E scratch" }),
      ],
      folders: [],
      header: null,
    };
    renderSection();
    const handler = keymap();
    expect(cursorRow().textContent).toBe("A note.note");
    press(handler, "3");
    press(handler, "j");
    expect(cursorRow().textContent).toBe("D web.account");
    press(handler, "G");
    expect(cursorRow().textContent).toBe("E scratch.note");
    press(handler, "1");
    press(handler, "G");
    expect(cursorRow().textContent).toBe("A note.note");
  });

  it("shows a timer with the expiry on hover for items with temporality", () => {
    vault.current = {
      items: [makeAccount(), makeDrop()],
      folders: [],
      header: null,
    };
    renderSection();
    const timer = screen.getByTitle(/^Expires /);
    expect(timer.textContent).toMatch(/^Expires /);
    expect(timer.textContent).toContain("2027");
    // Items without temporality get no timer.
    expect(screen.getAllByTitle(/^Expires /)).toHaveLength(1);
  });

  it("narrows to the query the command bar left in the address, and Esc clears it", () => {
    vault.current = {
      items: [makeAccount(), makeNote()],
      folders: [],
      header: null,
    };
    renderSection("/vault?f=all&q=web");
    // No second box: the prompt is the status bar's, not the pane's.
    expect(screen.queryByLabelText("Search items")).toBeNull();
    expect(
      screen.getAllByRole("treeitem").map((row) => row.textContent),
    ).toEqual(["Webmail.account"]);
    expect(screen.getByText(/1\/2 · \/web/)).toBeTruthy();
    press(keymap(), "Escape");
    expect(
      screen.getAllByRole("treeitem").map((row) => row.textContent),
    ).toEqual(["Scratch pad.note", "Webmail.account"]);
  });

  it("matches a folder by name and keeps its whole directory", () => {
    vault.current = {
      items: [
        makeAccount({ folderId: "f1" }),
        makeNote({ id: "itm_2", folderId: "f1" }),
      ],
      folders: [{ id: "f1", name: "Work", createdAt: "2026-08-01T00:00:00Z" }],
      header: null,
    };
    renderSection("/vault?q=work");
    // No item is named "work", but the directory is: it survives with all
    // of its children rather than vanishing from the tree.
    expect(
      screen.getAllByRole("treeitem").map((row) => row.textContent),
    ).toEqual(["Work/2", "Scratch pad.note", "Webmail.account"]);
  });

  it("returns no rows for a fruitless search", () => {
    vault.current = { items: [makeAccount()], folders: [], header: null };
    renderSection("/vault?q=zzzzzz");
    expect(screen.queryAllByRole("treeitem")).toHaveLength(0);
    expect(screen.getByText(/-\/1 · \/zzzzzz/)).toBeTruthy();
  });

  it("filters to favorites", () => {
    vault.current = {
      items: [makeAccount({ favorite: true }), makeNote()],
      folders: [],
      header: null,
    };
    renderSection("/vault?f=favorites");
    const rows = screen.getAllByRole("treeitem");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.querySelector(".vtree__name")?.textContent).toBe(
      "Webmail.account",
    );
    expect(screen.getByText(/1\/2 · Favorites/)).toBeTruthy();
  });

  it("filters by kind", () => {
    vault.current = {
      items: [makeAccount(), makeNote()],
      folders: [],
      header: null,
    };
    renderSection("/vault?f=note");
    expect(
      screen.getAllByRole("treeitem").map((row) => row.textContent),
    ).toEqual(["Scratch pad.note"]);
  });

  it("shows only trashed items under the trash filter", () => {
    vault.current = {
      items: [makeAccount({ deletedAt: "2026-08-10T00:00:00Z" }), makeNote()],
      folders: [],
      header: null,
    };
    renderSection("/vault?f=trash");
    expect(screen.getByText(/1\/1 · Trash/)).toBeTruthy();
    expect(
      screen.getAllByRole("treeitem").map((row) => row.textContent),
    ).toEqual(["Webmail.account"]);
  });

  it("shows the trash empty state", () => {
    vault.current = { items: [makeAccount()], folders: [], header: null };
    renderSection("/vault?f=trash");
    expect(screen.getByText("Trash is empty")).toBeTruthy();
  });

  it("filters to a folder", () => {
    vault.current = {
      items: [makeAccount({ folderId: "fld_1" }), makeNote()],
      folders: [{ id: "fld_1", name: "Work", createdAt: "2026-08-01" }],
      header: null,
    };
    renderSection("/vault?folder=fld_1");
    expect(screen.getByText(/1\/2 · Folder/)).toBeTruthy();
    expect(
      screen.getAllByRole("treeitem").map((row) => row.textContent),
    ).toEqual(["Webmail.account"]);
  });

  it("puts the cursor on the open item", () => {
    vault.current = {
      items: [makeAccount({ favorite: true }), makeNote()],
      folders: [],
      header: null,
    };
    renderSection("/vault/itm_1?f=favorites");
    expect(screen.getByText("detail pane")).toBeTruthy();
    expect(cursorRow().id).toBe("vtree-row-itm_1");
    expect(screen.getByText("personal:/Webmail.account")).toBeTruthy();
  });

  it("moves browser focus into the tree after collapse state is restored", async () => {
    vault.current = {
      items: [makeAccount()],
      folders: [],
      header: null,
    };
    renderSection();

    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("tree")),
    );
  });

  it("shows the favorite marker on a row", () => {
    vault.current = {
      items: [makeAccount(), makeNote({ favorite: true })],
      folders: [],
      header: null,
    };
    renderSection();
    expect(screen.getByTitle("Favorite")).toBeTruthy();
  });

  it("routes the new verb to the active item-kind ceremony", () => {
    for (const kind of [
      "account",
      "passkey",
      "card",
      "secret",
      "drop",
      "note",
      "certificate",
    ]) {
      vault.current = { items: [makeAccount()], folders: [], header: null };
      const view = renderSection(`/vault?f=${kind}`);
      // Non-empty filters carry the path-strip verb; empty ones offer the
      // same kind through the empty state's New item link.
      const hrefs = screen
        .getAllByRole("link")
        .map((link) => link.getAttribute("href"));
      expect(hrefs).toContain(`/vault/new/${kind}`);
      view.unmount();
    }
  });

  it("keyboard movement previews the item it lands on", () => {
    vault.current = {
      items: [makeAccount(), makeNote()],
      folders: [],
      header: null,
    };
    renderSection();
    const handler = keymap();
    // j lands on the first file: the buffer previews it without a click.
    press(handler, "j");
    expect(screen.getByText("detail pane")).toBeTruthy();
  });

  it("never yanks the pane while an editor owns it", () => {
    vault.current = {
      items: [makeAccount(), makeNote()],
      folders: [],
      header: null,
    };
    render(
      <MemoryRouter initialEntries={["/vault/itm_1/edit"]}>
        <Routes>
          <Route path="/vault" element={<VaultSection />}>
            <Route path=":itemId" element={<div>detail pane</div>} />
            <Route path=":itemId/edit" element={<div>editor pane</div>} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );
    const handler = keymap();
    press(handler, "j");
    press(handler, "j");
    expect(screen.getByText("editor pane")).toBeTruthy();
    expect(screen.queryByText("detail pane")).toBeNull();
  });

  it("routes focused-item keys through the existing vault actions", () => {
    const item = makeAccount();
    vault.current = { items: [item], folders: [], header: null };
    renderSection();
    const handler = keymap();

    press(handler, ".");
    press(handler, "x");

    expect(store.toggleFavorite).toHaveBeenCalledWith(item.id);
    expect(store.trashItem).not.toHaveBeenCalled();
    press(handler, "x");
    expect(store.trashItem).toHaveBeenCalledWith(item.id);
  });

  it("offers the row actions menu as a pointer twin of the verbs", () => {
    const item = makeAccount();
    vault.current = { items: [item], folders: [], header: null };
    renderSection();
    fireEvent.click(
      screen.getByRole("button", { name: "Actions for Webmail" }),
    );
    fireEvent.click(screen.getByRole("menuitem", { name: "Trash" }));
    expect(store.trashItem).not.toHaveBeenCalled();
    expect(screen.getByRole("menu")).toBeTruthy();
    fireEvent.click(
      screen.getByRole("menuitem", { name: "Really move to trash?" }),
    );
    expect(store.trashItem).toHaveBeenCalledWith(item.id);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("folders render as directories, expanded until collapsed by hand", async () => {
    vault.current = {
      items: [makeAccount({ folderId: "fld_1" })],
      folders: [{ id: "fld_1", name: "Work", createdAt: "2026-08-01" }],
      header: null,
    };
    renderSection();
    const dir = screen.getByRole("treeitem", { name: /Work/ });
    expect(dir.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText(/Webmail/)).toBeTruthy();

    await waitFor(() => expect(dir.getAttribute("aria-selected")).toBe("true"));
    fireEvent.click(dir);
    expect(dir.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText(/Webmail/)).toBeNull();
    await waitFor(() => {
      expect(saveCollapsed).toHaveBeenCalledWith("personal", ["Work/"]);
    });
  });

  it("restores the persisted collapse set per tomb", async () => {
    vault.current = {
      items: [makeAccount({ folderId: "fld_1" })],
      folders: [{ id: "fld_1", name: "Work", createdAt: "2026-08-01" }],
      header: null,
    };
    vaultTreeSeams.loadCollapsed = async () => ["Work/"];
    renderSection();
    await waitFor(() => {
      expect(
        screen
          .getByRole("treeitem", { name: /Work/ })
          .getAttribute("aria-expanded"),
      ).toBe("false");
    });
    expect(screen.queryByText(/Webmail/)).toBeNull();
  });

  it("climbs and dives directories with h and l", async () => {
    vault.current = {
      items: [makeAccount({ folderId: "fld_1" })],
      folders: [{ id: "fld_1", name: "Work", createdAt: "2026-08-01" }],
      header: null,
    };
    renderSection();
    const handler = keymap();
    await waitFor(() => expect(cursorRow().textContent).toContain("Work"));
    // l on an expanded directory steps onto its first child.
    press(handler, "l");
    expect(cursorRow().textContent).toBe("Webmail.account");
    // h climbs back to the directory row.
    press(handler, "h");
    expect(cursorRow().textContent).toContain("Work");
    // h on the expanded directory collapses it.
    press(handler, "h");
    expect(
      screen
        .getByRole("treeitem", { name: /Work/ })
        .getAttribute("aria-expanded"),
    ).toBe("false");
  });
});

describe("VaultWelcome", () => {
  beforeEach(() => {
    vault.current = { items: [], folders: [], header: null };
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("hands over the keys on an empty vault, without a second empty state", () => {
    renderWelcome();
    expect(screen.getByText("nothing sealed yet")).toBeTruthy();
    expect(screen.getByText("n new · import · ? keys")).toBeTruthy();
    expect(screen.queryByText(/Try the keyboard/)).toBeNull(); // list has it
    expect(
      screen.queryByRole("link", { name: /Add your first login/i }),
    ).toBeNull();
    expect(screen.queryByText("Nothing sealed on this device")).toBeNull();
  });

  it("states the seal and hands over the keys — no dashboard", () => {
    vault.current = {
      items: [
        makeAccount({
          totp: "JBSWY3DPEHPK3PXP",
          password: "X9!vQ2#mL8$pR4&zK7*wE1",
        }),
        makeNote(),
      ],
      folders: [],
      header: { kdf: { iterations: 600_000 } },
    };
    renderWelcome();
    expect(screen.getByText("2 items")).toBeTruthy();
    expect(
      screen.getByText(
        /Use the arrow keys or j\/k to move through vault items/,
      ),
    ).toBeTruthy();
    expect(screen.getByText(/enter open/)).toBeTruthy();
    // The stat-counter dashboard is gone for good.
    expect(screen.queryByText("What is in here")).toBeNull();
    expect(screen.queryByText("Recently changed")).toBeNull();
  });

  it("does not render password-health warnings in the vault pane", () => {
    vault.current = {
      items: [makeAccount({ password: "letmein" })],
      folders: [],
      header: {},
    };
    renderWelcome();
    expect(screen.queryByText(/passwords need attention/)).toBeNull();
    expect(screen.getByText("1 item")).toBeTruthy();
  });
});

/** Stands in for the buffer and offers Back, so a test can arrive as a person does. */
function DetailProbe() {
  const navigate = useNavigate();
  const location = useLocation();
  return (
    <div>
      <p>detail pane</p>
      <output data-testid="arrival">{useNavigationType()}</output>
      <output data-testid="where">{location.pathname}</output>
      <button type="button" onClick={() => navigate(-1)}>
        Back
      </button>
    </div>
  );
}

function renderWithHistory(entries: string[]) {
  return render(
    <MemoryRouter initialEntries={entries} initialIndex={entries.length - 1}>
      <Routes>
        <Route path="/vault" element={<VaultSection />}>
          <Route index element={<div>welcome pane</div>} />
          <Route path=":itemId" element={<DetailProbe />} />
        </Route>
        <Route path="/settings" element={<DetailProbe />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("VaultSection — where the keyboard lands", () => {
  beforeEach(() => {
    vault.current = {
      items: [makeAccount(), makeNote()],
      folders: [],
      header: null,
    };
    vaultTreeSeams.loadCollapsed = async () => [];
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("opening the item the cursor already previews replaces, so Back leaves it", () => {
    // Browsing is previewing: j replaces the list entry with the item, so the
    // entry before the vault is where Back belongs.
    renderWithHistory(["/settings", "/vault"]);
    const handler = keymap();
    press(handler, "j");
    expect(screen.getByTestId("arrival").textContent).toBe("REPLACE");
    // Enter on the previewed item is the same place: no second entry for it.
    press(handler, "Enter");
    expect(screen.getByTestId("arrival").textContent).toBe("REPLACE");
    expect(screen.getByTestId("where").textContent).toBe("/vault/itm_1");
    // Back now goes somewhere, rather than to the screen it was pressed on.
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByTestId("where").textContent).toBe("/settings");
    expect(screen.queryByRole("tree")).toBeNull();
  });

  it("opening a different item than the previewed one still pushes", () => {
    renderWithHistory(["/vault"]);
    const handler = keymap();
    press(handler, "j");
    // The cursor previews itm_1; a pointer opens the other file.
    const other = document.getElementById("vtree-row-itm_2");
    if (!other) throw new Error("expected the row for itm_2");
    fireEvent.click(other);
    expect(screen.getByTestId("arrival").textContent).toBe("PUSH");
    expect(screen.getByTestId("where").textContent).toBe("/vault/itm_2");
  });

  it("Back from a section hands the keyboard to the tree", async () => {
    renderWithHistory(["/vault", "/settings"]);
    expect(screen.queryByRole("tree")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("tree")),
    );
  });

  it("Back from an item lands on the tree when nothing else holds the keyboard", async () => {
    renderWithHistory(["/vault", "/vault/itm_1"]);
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("tree")),
    );
    // Something in the buffer took the keyboard, then the buffer went away.
    screen.getByRole("button", { name: "Back" }).focus();
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("tree")),
    );
  });

  it("an empty vault lands on the New item link", async () => {
    vault.current = { items: [], folders: [], header: null };
    renderWithHistory(["/vault"]);
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole("link", { name: "New item" }),
      ),
    );
  });
});
