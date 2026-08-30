import type { JsonObject } from "@opensesame/os-domain";
import {
  type FileTreeDirectoryHandle,
  type FileTreeItemHandle,
  FileTree as FileTreeModel,
  type FileTreeOptions,
} from "@pierre/trees";
import type { FileTreeProps } from "@pierre/trees/react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
/** @vitest-environment jsdom */
import { useState } from "react";
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
let treeOptions: FileTreeOptions | null = null;
let treeModel: FileTreeModel | null = null;
Object.assign(vaultHooksSeams, {
  useVault: () => vault.current,
  useVaultStore: () => store,
  useCopySecret: () => copySecret,
});
Object.assign(vaultTreeSeams, {
  activeTomb: () => "personal",
  loadExpanded: async () => [],
  saveExpanded: vi.fn(async () => undefined),
  useFileTree: (options: FileTreeOptions) => {
    const [model] = useState(() => new FileTreeModel(options));
    treeOptions = options;
    treeModel = model;
    return { model };
  },
  FileTree: ({ model }: FileTreeProps) => (
    <div data-testid="vault-tree">
      {model.getVisibleRows(0, model.getVisibleCount()).map((row) => {
        const item = { kind: row.kind, name: row.name, path: row.path };
        const decoration = treeOptions?.renderRowDecoration?.({ item, row });
        return (
          <button
            type="button"
            key={row.path}
            onClick={() => treeOptions?.onSelectionChange?.([row.path])}
          >
            {row.name}
            {decoration?.title ? (
              <span title={decoration.title}>
                {"text" in decoration ? decoration.text : decoration.title}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  ),
});

function currentTree(): FileTreeModel {
  if (!treeModel) throw new Error("Vault tree was not mounted.");
  return treeModel;
}

function isDirectory(
  item: FileTreeItemHandle | null,
): item is FileTreeDirectoryHandle {
  return item?.isDirectory() === true;
}

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

describe("VaultSection", () => {
  beforeEach(() => {
    vault.current = { items: [], folders: [], header: null };
    vaultTreeSeams.loadExpanded = async () => [];
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    // A file stashed by a test must not leak into the next one.
    takeImportFile();
    treeOptions = null;
    treeModel = null;
  });

  it("shows the empty state with new and import actions", () => {
    renderSection();
    expect(screen.getByText("Nothing here yet")).toBeTruthy();
    expect(
      screen.getByRole("link", { name: /New item/i }).getAttribute("href"),
    ).toBe("/vault/new/login");
    // The header and the empty state both open the import picker directly.
    expect(screen.getAllByRole("button", { name: /^Import$/i })).toHaveLength(
      2,
    );
  });

  it("picking a file from Import hands it to the settings import panel", () => {
    vault.current = {
      items: [makeLogin()],
      folders: [],
      header: null,
    };
    renderSection();
    // Import sits next to New even when the vault has items.
    expect(screen.getByRole("button", { name: /^Import$/i })).toBeTruthy();
    const file = new File(["KEY=value"], "app.env", { type: "text/plain" });
    fireEvent.change(screen.getByLabelText("Choose a file to import"), {
      target: { files: [file] },
    });
    // The file waits in the handoff for the panel, and the view moved to the
    // data settings where the panel will consume it.
    expect(takeImportFile()?.name).toBe("app.env");
    expect(screen.getByText("settings pane")).toBeTruthy();
  });

  it("lists items with names and count", () => {
    vault.current = {
      items: [makeLogin(), makeNote()],
      folders: [],
      header: null,
    };
    renderSection();
    expect(screen.getByText("Webmail")).toBeTruthy();
    expect(screen.getByText("Scratch pad")).toBeTruthy();
    expect(screen.getByText(/2\/2 · All items/)).toBeTruthy();
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

  it("uses the tree model for search", () => {
    vault.current = {
      items: [makeLogin(), makeNote()],
      folders: [],
      header: null,
    };
    renderSection();
    const model = currentTree();
    model.openSearch();
    model.setSearch("webmail");
    expect(model.getSearchMatchingPaths()).toEqual(["Webmail"]);
    model.closeSearch();
    expect(model.isSearchOpen()).toBe(false);
  });

  it("returns no tree matches for a fruitless search", () => {
    vault.current = { items: [makeLogin()], folders: [], header: null };
    renderSection();
    const model = currentTree();
    model.setSearch("zzzzzz");
    expect(model.getSearchMatchingPaths()).toEqual([]);
  });

  it("configures built-in hide-non-matches search", () => {
    vault.current = { items: [makeLogin()], folders: [], header: null };
    renderSection();
    expect(treeOptions?.search).toBe(true);
    expect(treeOptions?.fileTreeSearchMode).toBe("hide-non-matches");
  });

  it("filters to favorites", () => {
    vault.current = {
      items: [makeLogin({ favorite: true }), makeNote()],
      folders: [],
      header: null,
    };
    renderSection("/vault?f=favorites");
    expect(screen.getByRole("heading", { name: "Favorites" })).toBeTruthy();
    expect(screen.getByText("Webmail")).toBeTruthy();
    expect(screen.queryByText("Scratch pad")).toBeNull();
    expect(screen.getByText(/1\/2 · Favorites/)).toBeTruthy();
  });

  it("filters by kind", () => {
    vault.current = {
      items: [makeLogin(), makeNote()],
      folders: [],
      header: null,
    };
    renderSection("/vault?f=note");
    expect(screen.getByRole("heading", { name: "Secure notes" })).toBeTruthy();
    expect(screen.queryByText("Webmail")).toBeNull();
    expect(screen.getByText("Scratch pad")).toBeTruthy();
  });

  it("shows only trashed items under the trash filter", () => {
    vault.current = {
      items: [makeLogin({ deletedAt: "2026-08-10T00:00:00Z" }), makeNote()],
      folders: [],
      header: null,
    };
    renderSection("/vault?f=trash");
    expect(screen.getByRole("heading", { name: "Trash" })).toBeTruthy();
    expect(screen.getByText("Webmail")).toBeTruthy();
    expect(screen.queryByText("Scratch pad")).toBeNull();
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
    expect(screen.getByRole("heading", { name: "Folder" })).toBeTruthy();
    expect(screen.getByText("Webmail")).toBeTruthy();
    expect(screen.queryByText("Scratch pad")).toBeNull();
  });

  it("focuses the open item in the tree", () => {
    vault.current = {
      items: [makeLogin({ favorite: true })],
      folders: [],
      header: null,
    };
    renderSection("/vault/itm_1?f=favorites");
    expect(screen.getByText("detail pane")).toBeTruthy();
    expect(currentTree().getFocusedPath()).toBe("Webmail");
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

  it("routes New to the active item-kind ceremony", () => {
    for (const kind of [
      "login",
      "passkey",
      "card",
      "secret",
      "drop",
      "note",
      "certificate",
    ]) {
      const view = renderSection(`/vault?f=${kind}`);
      expect(
        screen.getByRole("link", { name: /^New$/ }).getAttribute("href"),
      ).toBe(`/vault/new/${kind}`);
      view.unmount();
    }
  });

  it("routes focused-item keys through the existing vault actions", () => {
    const item = makeLogin();
    vault.current = { items: [item], folders: [], header: null };
    renderSection();
    const handler = createKeymapHandler({
      navigate: vi.fn(),
      showHelp: vi.fn(),
    });

    handler(new KeyboardEvent("keydown", { key: "y", cancelable: true }));
    handler(new KeyboardEvent("keydown", { key: ".", cancelable: true }));
    handler(new KeyboardEvent("keydown", { key: "x", cancelable: true }));

    expect(copySecret).toHaveBeenCalledWith(item.password);
    expect(store.toggleFavorite).toHaveBeenCalledWith(item.id);
    expect(store.trashItem).toHaveBeenCalledWith(item.id);
  });

  it("restores and persists folder expansion per tomb", async () => {
    vault.current = {
      items: [makeLogin({ folderId: "fld_1" })],
      folders: [{ id: "fld_1", name: "Work", createdAt: "2026-08-01" }],
      header: null,
    };
    vaultTreeSeams.loadExpanded = async () => ["Work/"];
    renderSection();

    let folder = currentTree().getItem("Work/");
    await waitFor(() => {
      folder = currentTree().getItem("Work/");
      expect(isDirectory(folder) && folder.isExpanded()).toBe(true);
    });
    if (!isDirectory(folder)) throw new Error("Work folder was not mounted.");
    folder.toggle();

    await waitFor(() => {
      expect(vaultTreeSeams.saveExpanded).toHaveBeenCalledWith("personal", []);
    });
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

  it("summarises the vault contents and recent changes", () => {
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
    expect(screen.getByText("2 items, sealed")).toBeTruthy();
    expect(screen.getByText(/600,000 PBKDF2 iterations/)).toBeTruthy();
    expect(screen.getByText("Logins")).toBeTruthy();
    expect(screen.getByText("Secure notes")).toBeTruthy();
    expect(screen.getByText("Recently changed")).toBeTruthy();
    expect(screen.queryByText(/passwords need attention/)).toBeNull();
    // New-item shortcuts for every kind.
    expect(
      screen.getByRole("link", { name: "Secret" }).getAttribute("href"),
    ).toBe("/vault/new/secret");
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
