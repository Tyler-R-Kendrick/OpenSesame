/** @vitest-environment jsdom */
import { registerLegacyItemKinds } from "@opensesame/app-core/lib/contributions.test-support.js";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createKeymapHandler } from "../../lib/keymap.js";
import { vaultHooksSeams } from "../../lib/vault/hooks.js";
import { VaultSection } from "../VaultSection.js";
import { vaultTreeSeams } from "./VaultTree.js";
import { expectVaultCommands } from "./commands.test-support.js";
import { makeAccount, makeNote } from "./section-items.test-support.js";
import { PURGE_CONFIRM } from "./vault-menu.js";

registerLegacyItemKinds();

type TestVault = {
  items: Array<ReturnType<typeof makeAccount> | ReturnType<typeof makeNote>>;
  folders: [];
  header: null;
};
type TestVaultCell = { current: TestVault };

const vault: TestVaultCell = {
  current: { items: [], folders: [], header: null },
};
const store = {
  purgeItem: vi.fn(),
  restoreItem: vi.fn(),
  trashItem: vi.fn(),
  toggleFavorite: vi.fn(),
};
Object.assign(vaultHooksSeams, {
  useVault: () => vault.current,
  useVaultStore: () => store,
  useCopySecret: () => vi.fn(),
});
Object.assign(vaultTreeSeams, {
  activeTomb: () => "personal",
  loadCollapsed: async (): Promise<string[]> => [],
  saveCollapsed: async () => undefined,
});

function Where() {
  const location = useLocation();
  return (
    <output data-testid="where">
      {location.pathname}
      {location.search}
    </output>
  );
}

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Where />
      <Routes>
        <Route path="/vault" element={<VaultSection />}>
          <Route index element={<div>welcome pane</div>} />
          <Route path="new" element={<div>new item</div>} />
          <Route path=":itemId" element={<div>detail pane</div>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

function press(key: string) {
  const handler = createKeymapHandler({ navigate: vi.fn(), showHelp: vi.fn() });
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

function iconOnly(name: string) {
  const control = screen.getByRole("button", { name });
  expect(control.textContent).toBe("");
  expect(control.querySelector("svg")).not.toBeNull();
  expect(control.getAttribute("title")).toBeTruthy();
  return control;
}

describe("trash directory commands", () => {
  beforeEach(() => {
    vault.current = { items: [], folders: [], header: null };
    vi.clearAllMocks();
  });
  afterEach(cleanup);

  it("keeps new, import and export on a live listing", () => {
    renderAt("/vault");
    expectVaultCommands();
  });

  it("replaces add, import and export with restore and delete", () => {
    vault.current = {
      items: [makeAccount({ deletedAt: "2026-08-10T00:00:00Z" })],
      folders: [],
      header: null,
    };
    renderAt("/vault?f=trash");
    const bar = screen.getByRole("group", { name: "Vault commands" });
    expect(within(bar).queryByRole("link", { name: "New item" })).toBeNull();
    expect(
      within(bar).queryByRole("button", { name: "Import items" }),
    ).toBeNull();
    expect(
      within(bar).queryByRole("button", { name: "Export items" }),
    ).toBeNull();
    iconOnly("Restore");
    expect(
      screen.getByRole("button", { name: "Restore" }).getAttribute("title"),
    ).toBe("Restore (r)");
    iconOnly("Delete permanently");
    fireEvent.click(screen.getByRole("button", { name: "Restore" }));
    expect(store.restoreItem).toHaveBeenCalledWith("itm_1");
  });

  it("asks once, then deletes the cursor item", () => {
    vault.current = {
      items: [
        makeNote({ deletedAt: "2026-08-10T00:00:00Z" }),
        makeAccount({ deletedAt: "2026-08-11T00:00:00Z" }),
      ],
      folders: [],
      header: null,
    };
    renderAt("/vault?f=trash");
    press("j");
    const cursor = document.querySelector<HTMLElement>(
      ".vtree__rows [aria-selected='true']",
    );
    fireEvent.click(screen.getByRole("button", { name: "Delete permanently" }));
    expect(store.purgeItem).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: PURGE_CONFIRM }));
    expect(store.purgeItem).toHaveBeenCalledTimes(1);
    expect(store.purgeItem).toHaveBeenCalledWith(cursor?.dataset.vtreeKey);
  });

  it("does not add from the trash, and deletes from the keyboard", () => {
    vault.current = {
      items: [makeAccount({ deletedAt: "2026-08-10T00:00:00Z" })],
      folders: [],
      header: null,
    };
    renderAt("/vault?f=trash");
    press("n");
    expect(screen.getByTestId("where").textContent).toBe("/vault?f=trash");
    press("X");
    expect(store.purgeItem).not.toHaveBeenCalled();
    press("X");
    expect(store.purgeItem).toHaveBeenCalledWith("itm_1");
  });

  it("leaves a live item alone", () => {
    vault.current = { items: [makeAccount()], folders: [], header: null };
    renderAt("/vault");
    press("r");
    press("X");
    expect(store.restoreItem).not.toHaveBeenCalled();
    expect(store.purgeItem).not.toHaveBeenCalled();
    press("n");
    expect(screen.getByTestId("where").textContent).toBe("/vault/new");
  });

  it("disables both keys when the trash is empty and lands on the filter", async () => {
    vault.current = { items: [makeAccount()], folders: [], header: null };
    // jsdom focuses a hidden tree; hold the collapse load so it cannot steal.
    vaultTreeSeams.loadCollapsed = () => new Promise(() => undefined);
    renderAt("/vault?f=trash");
    expect(
      screen.getByRole<HTMLButtonElement>("button", { name: "Restore" })
        .disabled,
    ).toBe(true);
    expect(
      screen.getByRole<HTMLButtonElement>("button", {
        name: "Delete permanently",
      }).disabled,
    ).toBe(true);
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole("link", { name: "Vault" }),
      ),
    );
  });
});
