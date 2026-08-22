import type { JsonObject } from "@opensesame/os-domain";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
/** @vitest-environment jsdom */
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Folder, LoginItem, NoteItem } from "../lib/vault/model.js";

const vault: {
  current: {
    items: Array<LoginItem | NoteItem>;
    folders: Folder[];
    header: JsonObject | null;
  };
} = {
  current: {
    items: [],
    folders: [],
    header: null,
  },
};

import { vaultHooksSeams } from "../lib/vault/hooks.js";
const originalVaultHooksSeams = { ...vaultHooksSeams };
Object.assign(vaultHooksSeams, { useVault: () => vault.current });

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

describe("VaultSection", () => {
  beforeEach(() => {
    vault.current = { items: [], folders: [], header: null };
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("shows the empty state with new and import actions", () => {
    renderSection();
    expect(screen.getByText("Nothing here yet")).toBeTruthy();
    expect(
      screen.getByRole("link", { name: /New item/i }).getAttribute("href"),
    ).toBe("/vault/new/login");
    expect(
      screen.getByRole("link", { name: /Import/i }).getAttribute("href"),
    ).toBe("/settings/data#import");
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
    expect(screen.getByText("2 items")).toBeTruthy();
  });

  it("filters by search and clears with Escape", async () => {
    vault.current = {
      items: [makeLogin(), makeNote()],
      folders: [],
      header: null,
    };
    renderSection();
    const search = screen.getByLabelText("Search vault items");
    await userEvent.type(search, "webmail");
    expect(screen.getByText("Webmail")).toBeTruthy();
    expect(screen.queryByText("Scratch pad")).toBeNull();
    expect(screen.getByText(/matching “webmail”/)).toBeTruthy();
    fireEvent.keyDown(search, { key: "Escape" });
    expect(screen.getByText("Scratch pad")).toBeTruthy();
  });

  it("shows the no-match empty state for fruitless searches", async () => {
    vault.current = { items: [makeLogin()], folders: [], header: null };
    renderSection();
    await userEvent.type(screen.getByLabelText("Search vault items"), "zzzzzz");
    expect(screen.getByText("Nothing matches")).toBeTruthy();
    expect(screen.getByText(/not concealed values/)).toBeTruthy();
  });

  it("focuses search when / is pressed outside a field", () => {
    vault.current = { items: [makeLogin()], folders: [], header: null };
    renderSection();
    const search =
      screen.getByLabelText<HTMLInputElement>("Search vault items");
    fireEvent.keyDown(window, { key: "/" });
    expect(document.activeElement).toBe(search);
  });

  it("ignores / pressed while typing in a field", async () => {
    vault.current = { items: [makeLogin()], folders: [], header: null };
    renderSection();
    const search =
      screen.getByLabelText<HTMLInputElement>("Search vault items");
    search.focus();
    fireEvent.keyDown(search, { key: "/" });
    // Already-focused input keeps focus; the key is not hijacked again.
    expect(document.activeElement).toBe(search);
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
    expect(screen.getByText("1 item")).toBeTruthy();
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

  it("marks the open item as active and carries the filter into its link", () => {
    vault.current = { items: [makeLogin()], folders: [], header: null };
    vault.current = {
      items: [makeLogin({ favorite: true })],
      folders: [],
      header: null,
    };
    renderSection("/vault/itm_1?f=favorites");
    expect(screen.getByText("detail pane")).toBeTruthy();
    const row = screen.getByRole("link", { name: /Webmail/ });
    expect(row.getAttribute("aria-current")).toBe("true");
    expect(row.getAttribute("href")).toBe("/vault/itm_1?f=favorites");
  });

  it("shows sample and favorite markers on rows", () => {
    vault.current = {
      items: [makeLogin({ sample: true, favorite: true })],
      folders: [],
      header: null,
    };
    renderSection();
    expect(screen.getByText("SYNTHETIC")).toBeTruthy();
    expect(screen.getByTitle("Favorite")).toBeTruthy();
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
    // Health hint: one scored password that is strong, unique, and current.
    expect(
      screen.getByText(/All 1 passwords are strong, unique, and current/),
    ).toBeTruthy();
    // New-item shortcuts for every kind.
    expect(
      screen.getByRole("link", { name: /Agent secret/i }).getAttribute("href"),
    ).toBe("/vault/new/secret");
  });

  it("warns when passwords need attention", () => {
    vault.current = {
      items: [makeLogin({ password: "letmein" })],
      folders: [],
      header: {},
    };
    renderWelcome();
    expect(screen.getByText(/1 of 1 passwords need attention/)).toBeTruthy();
    expect(
      screen.getByText(/unlock again with an enrolled passkey/),
    ).toBeTruthy();
  });
});
