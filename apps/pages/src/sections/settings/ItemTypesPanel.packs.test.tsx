/** @vitest-environment jsdom */
import { packSeams } from "@opensesame/app-core/lib/type-packs/installer.js";
import {
  resetPackStateForTests,
  setCounts,
} from "@opensesame/app-core/lib/type-packs/state.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import { lockAllTombs, unlockTomb } from "@opensesame/app-core/lib/vfs.js";
import { mintVaultKey, syncInstalledTypes } from "@opensesame/vault-core";
import {
  dropPack,
  isPackLoaded,
  packEntries,
} from "@opensesame/vault-item-types";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { vaultHooksSeams } from "../../lib/vault/hooks.js";
import { ItemTypesPanel } from "./ItemTypesPanel.js";
import { SettingsFileContext } from "./files/context.js";

// The switches: one per built-in type beyond the core, each a download.
const originalHooks = { ...vaultHooksSeams };
const originalPacks = { ...packSeams };
let tombs = 0;
let TOMB = "itype-packs-0";
const store = {
  activeTomb: () => TOMB,
  installItemTypeDefinition: vi.fn(),
  uninstallItemTypeDefinition: vi.fn(),
};

function renderPanel() {
  return render(
    <SettingsFileContext.Provider value={{ openFile: vi.fn() }}>
      <ItemTypesPanel />
    </SettingsFileContext.Provider>,
  );
}

beforeEach(async () => {
  tombs += 1;
  TOMB = `itype-packs-${tombs}`;
  unlockTomb(TOMB, (await mintVaultKey()).vaultKey);
  syncInstalledTypes({});
  Object.assign(vaultHooksSeams, {
    useVault: () => vaultStore.getSnapshot(),
    useVaultStore: () => store,
  });
  // Packs arrive on demand: the suite starts with every one of them off.
  for (const entry of packEntries()) dropPack(entry.id);
  resetPackStateForTests();
});

afterEach(() => {
  cleanup();
  Object.assign(packSeams, originalPacks);
  Object.assign(vaultHooksSeams, originalHooks);
  syncInstalledTypes({});
  lockAllTombs();
});

describe("ItemTypesPanel switches", () => {
  it("draws one switch per built-in type beyond the core, all off, and no tabs", () => {
    renderPanel();
    expect(screen.queryAllByRole("tab")).toEqual([]);
    const switches = screen.getAllByRole("switch");
    expect(switches).toHaveLength(23);
    expect(
      switches.every((node) => node.getAttribute("aria-checked") === "false"),
    ).toBe(true);
    expect(screen.getByText("0 of 23 on")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Remove / })).toBeNull();
    // Nothing of yours says nothing: one key to write a type, no sentence.
    expect(screen.queryByText(/No installed types yet/)).toBeNull();
    expect(
      screen.getByRole("button", { name: "Write a new item type" }),
    ).toBeTruthy();
  });

  it("groups the switches by what they are for", () => {
    renderPanel();
    for (const name of ["Access", "Developer", "Finance", "Identity"]) {
      expect(screen.getByRole("heading", { name })).toBeTruthy();
    }
  });

  it("narrows the list by any word, and says when nothing matches", () => {
    renderPanel();
    const field = screen.getByLabelText("Search item types");
    fireEvent.change(field, { target: { value: "wi-fi" } });
    expect(
      screen.getAllByRole("switch").map((n) => n.getAttribute("aria-label")),
    ).toEqual(["Wi-Fi network"]);
    fireEvent.change(field, { target: { value: "zzzz" } });
    expect(screen.queryAllByRole("switch")).toEqual([]);
    expect(screen.getByText(/No item type matches/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
    expect(screen.getAllByRole("switch")).toHaveLength(23);
  });

  it("downloads and installs a type when its switch goes on, and tells the live region", async () => {
    renderPanel();
    const account = screen.getByRole("switch", { name: "Address" });
    fireEvent.click(account);
    // On its way the switch is already set and marked busy.
    expect(account.getAttribute("aria-checked")).toBe("true");
    expect(account.getAttribute("aria-busy")).toBe("true");
    await waitFor(() =>
      expect(account.getAttribute("aria-busy")).toBe("false"),
    );
    expect(isPackLoaded("address")).toBe(true);
    expect(screen.getByText("1 of 23 on")).toBeTruthy();
    expect(screen.getByText("Address installed.")).toBeTruthy();
  });

  it("shows a failure on the row and retries when the switch is pressed again", async () => {
    packSeams.fetchText = () => Promise.reject(new Error("Offline."));
    renderPanel();
    fireEvent.click(screen.getByRole("switch", { name: "Address" }));
    await screen.findByRole("img", {
      name: "Address did not install: Offline.",
    });
    expect(
      screen
        .getByRole("switch", { name: "Address" })
        .getAttribute("aria-checked"),
    ).toBe("false");
    packSeams.fetchText = originalPacks.fetchText;
    fireEvent.click(screen.getByRole("switch", { name: "Address" }));
    await waitFor(() => expect(isPackLoaded("address")).toBe(true));
  });

  it("switches a type off again, and keeps one the vault holds items of", async () => {
    renderPanel();
    fireEvent.click(screen.getByRole("switch", { name: "Card" }));
    await waitFor(() => expect(isPackLoaded("card")).toBe(true));
    fireEvent.click(screen.getByRole("switch", { name: "Card" }));
    await waitFor(() => expect(isPackLoaded("card")).toBe(false));

    fireEvent.click(screen.getByRole("switch", { name: "Secure note" }));
    await waitFor(() => expect(isPackLoaded("note")).toBe(true));
    act(() => setCounts(new Map([["note", 4]])));
    // Held: no switch, its count in its place.
    expect(screen.queryByRole("switch", { name: "Secure note" })).toBeNull();
    expect(
      screen.getByRole("img", {
        name: "Secure note stays on: this vault has 4 items of it.",
      }),
    ).toBeTruthy();
  });
});

describe("ItemTypesPanel: a type another needs", () => {
  it("holds Password on while Account is on, with the reason and no count", async () => {
    renderPanel();
    fireEvent.click(screen.getByRole("switch", { name: "Account" }));
    await waitFor(() =>
      expect(
        screen.getByRole("img", {
          name: "Password stays on: Account needs it.",
        }),
      ).toBeTruthy(),
    );
    expect(screen.queryByRole("switch", { name: "Password" })).toBeNull();
  });
});
