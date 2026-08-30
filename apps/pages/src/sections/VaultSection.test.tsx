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
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createKeymapHandler } from "../lib/keymap.js";
import type {
  DropItem,
  Folder,
  LoginItem,
  NoteItem,
} from "../lib/vault/model.js";

type VaultHarness = {
  current: {
    items: Array<LoginItem | NoteItem | DropItem>;
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
import { takeImportFile } from "../lib/vault/import/handoff.js";
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

function makeLogin(overrides: Partial<LoginItem> = {}): LoginItem {
  return {
    id: "itm_1",
    kind: "login",
    name: "Webmail",
    folderId: null,
    favorite: false,
    notes: "",
    fields: [],
    createdAt: "2026-08-01T00:00:00Z",
    updatedAt: "2026-08-02T00:00:00Z",
    deletedAt: null,
    username: "me@example.com",
    password: "hunter2hunter2hunter2",
    totp: "",
    uris: [],
    passwordChangedAt: "2026-08-01T00:00:00Z",
    ...overrides,
  };
}

function makeNote(overrides: Partial<NoteItem> = {}): NoteItem {
  return {
    id: "itm_2",
    kind: "note",
    name: "Scratch pad",
    folderId: null,
    favorite: false,
    notes: "remember the milk",
    fields: [],
    createdAt: "2026-08-01T00:00:00Z",
    updatedAt: "2026-08-01T00:00:00Z",
    deletedAt: null,
    ...overrides,
  };
}

function makeDrop(overrides: Partial<DropItem> = {}): DropItem {
  return {
    id: "itm_drop",
    kind: "drop",
    name: "amber-falcon-breeze",
    folderId: null,
    favorite: false,
    notes: "",
    fields: [],
    createdAt: "2026-08-01T00:00:00Z",
    updatedAt: "2026-08-01T00:00:00Z",
    deletedAt: null,
    state: "pending",
    claimId: "clm_1",
    bearerToken: "osc_clm_clm_1.secret",
    expiresAt: "2027-01-15T10:30:00.000Z",
    ...overrides,
  };
}

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
        <Route path="/settings/data" element={<div>settings pane</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

function keymap() {
  return createKeymapHandler({ navigate: vi.fn(), showHelp: vi.fn() });
}

function press(handler: (event: KeyboardEvent) => void, key: string) {
  act(() => {
    handler(new KeyboardEvent("keydown", { key, cancelable: true }));
  });
}

function cursorRow(): HTMLElement {
  const row = screen
    .getAllByRole("treeitem")
    .find((candidate) => candidate.getAttribute("aria-selected") === "true");
  if (!row) throw new Error("No cursor row.");
  return row;
}

describe("VaultSection", () => {
  beforeEach(() => {
    vault.current = { items: [], folders: [], header: null };
    vaultTreeSeams.loadCollapsed = async () => [];
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    // A file stashed by a test must not leak into the next one.
    takeImportFile();
  });

  it("shows the empty state with new and import actions", () => {
    renderSection();
    expect(screen.getByText("Nothing here yet")).toBeTruthy();
    expect(
      screen.getByRole("link", { name: /New item/i }).getAttribute("href"),
    ).toBe("/vault/new/login");
    // The empty state opens the import picker directly.
    expect(screen.getAllByRole("button", { name: /^Import$/i })).toHaveLength(
      1,
    );
  });

  it("picking a file from Import hands it to the settings import panel", () => {
    vault.current = {
      items: [makeLogin()],
      folders: [],
      header: null,
    };
    renderSection();
    // Import sits beside new in the path strip even when the vault has items.
    expect(screen.getByRole("button", { name: "Import items" })).toBeTruthy();
    const file = new File(["KEY=value"], "app.env", { type: "text/plain" });
    fireEvent.change(screen.getByLabelText("Choose a file to import"), {
      target: { files: [file] },
    });
    // The file waits in the handoff for the panel, and the view moved to the
    // data settings where the panel will consume it.
    expect(takeImportFile()?.name).toBe("app.env");
    expect(screen.getByText("settings pane")).toBeTruthy();
  });

  it("lists items as files with kind extensions and a status line", () => {
    vault.current = {
      items: [makeLogin(), makeNote()],
      folders: [],
      header: null,
    };
    renderSection();
    const rows = screen.getAllByRole("treeitem");
    expect(rows.map((row) => row.textContent)).toEqual([
      "Scratch pad.note",
      "Webmail.login",
    ]);
    expect(screen.getByText(/2\/2 · All items/)).toBeTruthy();
  });

  it("owns a visible cursor that the keymap moves", () => {
    vault.current = {
      items: [makeLogin(), makeNote()],
      folders: [],
      header: null,
    };
    renderSection();
    const handler = keymap();
    // The cursor lands on the first row without any input.
    expect(cursorRow().textContent).toBe("Scratch pad.note");
    press(handler, "j");
    expect(cursorRow().textContent).toBe("Webmail.login");
    // The status line follows the cursor with the tomb-rooted path.
    expect(screen.getByText("personal:/Webmail.login")).toBeTruthy();
    press(handler, "k");
    expect(cursorRow().textContent).toBe("Scratch pad.note");
    press(handler, "G");
    expect(cursorRow().textContent).toBe("Webmail.login");
    press(handler, "g");
    press(handler, "g");
    expect(cursorRow().textContent).toBe("Scratch pad.note");
  });

  it("shows a timer with the expiry on hover for items with temporality", () => {
    vault.current = {
      items: [makeLogin(), makeDrop()],
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

  it("opens a / command line that filters and never leaks keys", () => {
    vault.current = {
      items: [makeLogin(), makeNote()],
      folders: [],
      header: null,
    };
    renderSection();
    const handler = keymap();
    press(handler, "/");
    const input = screen.getByLabelText("Search items");
    fireEvent.change(input, { target: { value: "web" } });
    expect(
      screen.getAllByRole("treeitem").map((row) => row.textContent),
    ).toEqual(["Webmail.login"]);
    expect(screen.getByText(/1\/2 · \/web/)).toBeTruthy();
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByLabelText("Search items")).toBeNull();
    expect(
      screen.getAllByRole("treeitem").map((row) => row.textContent),
    ).toEqual(["Scratch pad.note", "Webmail.login"]);
  });

  it("matches a folder by name and keeps its whole directory", () => {
    vault.current = {
      items: [
        makeLogin({ folderId: "f1" }),
        makeNote({ id: "itm_2", folderId: "f1" }),
      ],
      folders: [{ id: "f1", name: "Work", createdAt: "2026-08-01T00:00:00Z" }],
      header: null,
    };
    renderSection();
    const handler = keymap();
    press(handler, "/");
    fireEvent.change(screen.getByLabelText("Search items"), {
      target: { value: "work" },
    });
    // No item is named "work", but the directory is: it survives with all
    // of its children rather than vanishing from the tree.
    expect(
      screen.getAllByRole("treeitem").map((row) => row.textContent),
    ).toEqual(["Work/2", "Scratch pad.note", "Webmail.login"]);
  });

  it("returns no rows for a fruitless search", () => {
    vault.current = { items: [makeLogin()], folders: [], header: null };
    renderSection();
    const handler = keymap();
    press(handler, "/");
    fireEvent.change(screen.getByLabelText("Search items"), {
      target: { value: "zzzzzz" },
    });
    expect(screen.queryAllByRole("treeitem")).toHaveLength(0);
    expect(screen.getByText(/0\/1 · \/zzzzzz/)).toBeTruthy();
  });

  it("filters to favorites", () => {
    vault.current = {
      items: [makeLogin({ favorite: true }), makeNote()],
      folders: [],
      header: null,
    };
    renderSection("/vault?f=favorites");
    const rows = screen.getAllByRole("treeitem");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.querySelector(".vtree__name")?.textContent).toBe(
      "Webmail.login",
    );
    expect(screen.getByText(/1\/2 · Favorites/)).toBeTruthy();
  });

  it("filters by kind", () => {
    vault.current = {
      items: [makeLogin(), makeNote()],
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
      items: [makeLogin({ deletedAt: "2026-08-10T00:00:00Z" }), makeNote()],
      folders: [],
      header: null,
    };
    renderSection("/vault?f=trash");
    expect(screen.getByText(/1\/1 · Trash/)).toBeTruthy();
    expect(
      screen.getAllByRole("treeitem").map((row) => row.textContent),
    ).toEqual(["Webmail.login"]);
  });

  it("shows the trash empty state", () => {
    vault.current = { items: [makeLogin()], folders: [], header: null };
    renderSection("/vault?f=trash");
    expect(screen.getByText(/Deleted items wait here/)).toBeTruthy();
  });

  it("filters to a folder", () => {
    vault.current = {
      items: [makeLogin({ folderId: "fld_1" }), makeNote()],
      folders: [{ id: "fld_1", name: "Work", createdAt: "2026-08-01" }],
      header: null,
    };
    renderSection("/vault?folder=fld_1");
    expect(screen.getByText(/1\/2 · Folder/)).toBeTruthy();
    expect(
      screen.getAllByRole("treeitem").map((row) => row.textContent),
    ).toEqual(["Webmail.login"]);
  });

  it("puts the cursor on the open item", () => {
    vault.current = {
      items: [makeLogin({ favorite: true }), makeNote()],
      folders: [],
      header: null,
    };
    renderSection("/vault/itm_1?f=favorites");
    expect(screen.getByText("detail pane")).toBeTruthy();
    expect(cursorRow().id).toBe("vtree-row-itm_1");
    expect(screen.getByText("personal:/Webmail.login")).toBeTruthy();
  });

  it("shows sample and favorite markers on rows", () => {
    vault.current = {
      items: [makeLogin({ sample: true }), makeNote({ favorite: true })],
      folders: [],
      header: null,
    };
    renderSection();
    expect(screen.getByText("SYNTHETIC")).toBeTruthy();
    expect(screen.getByTitle("Favorite")).toBeTruthy();
  });

  it("routes the new verb to the active item-kind ceremony", () => {
    for (const kind of [
      "login",
      "passkey",
      "card",
      "secret",
      "drop",
      "note",
      "certificate",
    ]) {
      vault.current = { items: [makeLogin()], folders: [], header: null };
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
      items: [makeLogin(), makeNote()],
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
      items: [makeLogin(), makeNote()],
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
    const item = makeLogin();
    vault.current = { items: [item], folders: [], header: null };
    renderSection();
    const handler = keymap();

    press(handler, "y");
    press(handler, ".");
    press(handler, "x");

    expect(copySecret).toHaveBeenCalledWith(item.password);
    expect(store.toggleFavorite).toHaveBeenCalledWith(item.id);
    expect(store.trashItem).toHaveBeenCalledWith(item.id);
  });

  it("offers the row actions menu as a pointer twin of the verbs", () => {
    const item = makeLogin();
    vault.current = { items: [item], folders: [], header: null };
    renderSection();
    fireEvent.click(
      screen.getByRole("button", { name: "Actions for Webmail" }),
    );
    fireEvent.click(screen.getByRole("menuitem", { name: "Trash" }));
    expect(store.trashItem).toHaveBeenCalledWith(item.id);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("folders render as directories, expanded until collapsed by hand", async () => {
    vault.current = {
      items: [makeLogin({ folderId: "fld_1" })],
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
      items: [makeLogin({ folderId: "fld_1" })],
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
      items: [makeLogin({ folderId: "fld_1" })],
      folders: [{ id: "fld_1", name: "Work", createdAt: "2026-08-01" }],
      header: null,
    };
    renderSection();
    const handler = keymap();
    await waitFor(() => expect(cursorRow().textContent).toContain("Work"));
    // l on an expanded directory steps onto its first child.
    press(handler, "l");
    expect(cursorRow().textContent).toBe("Webmail.login");
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

  it("renders kind and folder filter chips only for present kinds", () => {
    vault.current = {
      items: [makeLogin()],
      folders: [{ id: "fld_1", name: "Work", createdAt: "2026-08-01" }],
      header: null,
    };
    renderSection();
    const chips = screen.getByRole("group", { name: /Filter items/i });
    expect(chips.textContent).toContain("Logins");
    expect(chips.textContent).not.toContain("Passkeys");
    expect(chips.textContent).toContain("Work");
    expect(chips.textContent).toContain("Trash");
    expect(chips.textContent).toContain("Health");
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

  it("offers the first-login path on an empty vault", () => {
    renderWelcome();
    expect(screen.getByText("Nothing sealed on this device")).toBeTruthy();
    expect(
      screen
        .getByRole("link", { name: /Add your first login/i })
        .getAttribute("href"),
    ).toBe("/vault/new/login");
  });

  it("states the seal and hands over the keys — no dashboard", () => {
    vault.current = {
      items: [
        makeLogin({
          totp: "JBSWY3DPEHPK3PXP",
          password: "X9!vQ2#mL8$pR4&zK7*wE1",
        }),
        makeNote(),
      ],
      folders: [],
      header: { kdf: { iterations: 600_000 } },
    };
    renderWelcome();
    expect(screen.getByText(/2 items, sealed/)).toBeTruthy();
    expect(screen.getByText(/600,000 PBKDF2 iterations/)).toBeTruthy();
    expect(screen.getByText(/j\/k browse/)).toBeTruthy();
    // The stat-counter dashboard is gone for good.
    expect(screen.queryByText("What is in here")).toBeNull();
    expect(screen.queryByText("Recently changed")).toBeNull();
  });

  it("does not render password-health warnings in the vault pane", () => {
    vault.current = {
      items: [makeLogin({ password: "letmein" })],
      folders: [],
      header: {},
    };
    renderWelcome();
    expect(screen.queryByText(/passwords need attention/)).toBeNull();
    expect(
      screen.getByText(/unlock again with an enrolled passkey/),
    ).toBeTruthy();
  });
});
