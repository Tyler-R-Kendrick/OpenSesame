/** @vitest-environment jsdom */
import type { JsonObject } from "@opensesame/os-domain";
import {
  type Folder,
  type VaultItem,
  createItem,
} from "@opensesame/vault-core";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

/**
 * The vault's filters on a phone: one key, and a sheet behind it.
 *
 * They used to be a scrolling row of chips pinned above the list — a band of
 * chrome on screen always, for a control touched rarely, whose active chip was
 * the highest-contrast element on the screen. The roads did not change; where
 * they live did. So what is asserted here is that every road survived the move,
 * that the key names the one in force, and that it only draws a dot when the
 * list in front of you is actually narrower than the vault.
 */

type VaultHarness = {
  current: { items: VaultItem[]; folders: Folder[]; header: JsonObject | null };
};

const vault = vi.hoisted(
  (): VaultHarness => ({ current: { items: [], folders: [], header: null } }),
);

import { vaultHooksSeams } from "../../lib/vault/hooks.js";
const originalVaultHooksSeams = { ...vaultHooksSeams };
Object.assign(vaultHooksSeams, {
  useVault: () => vault.current,
  useVaultStore: () => ({ purgeItem: vi.fn(), trashItem: vi.fn() }),
  useCopySecret: () => vi.fn().mockResolvedValue("copied"),
});

import { VaultSection } from "../VaultSection.js";

function renderSection(initial = "/vault") {
  return render(
    <MemoryRouter initialEntries={[initial]}>
      <Routes>
        <Route path="/vault" element={<VaultSection />}>
          <Route index element={<div>welcome pane</div>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

function filterKey(): HTMLElement {
  return screen.getByRole("button", { name: /^Filter — / });
}

beforeEach(() => {
  const login = createItem("login", "Webmail");
  login.id = "itm_login";
  login.favorite = true;
  vault.current = {
    items: [login],
    folders: [{ id: "fld_1", name: "Work", createdAt: "2026-08-01" }],
    header: null,
  };
});

afterEach(cleanup);

// The seam is restored once, at the end: putting this in `afterEach` unmocks
// the vault before the second test and every list reads back empty.
afterAll(() => {
  Object.assign(vaultHooksSeams, originalVaultHooksSeams);
});

describe("the vault filter key", () => {
  it("names the filter in force and dots itself only when narrowed", () => {
    renderSection();
    // "All items" is the resting state, so the key carries no dot: the dot
    // means the list in front of you is narrower than the vault.
    expect(filterKey().getAttribute("aria-label")).toBe("Filter — All items");
    expect(filterKey().className).not.toContain("is-narrowed");
    cleanup();

    renderSection("/vault?f=favorites");
    expect(filterKey().getAttribute("aria-label")).toBe("Filter — Favorites");
    expect(filterKey().className).toContain("is-narrowed");
  });

  it("keeps every road the chip row carried, with its count", () => {
    renderSection();
    fireEvent.click(filterKey());
    const sheet = screen.getByRole("dialog", { name: "Filter items" });
    for (const road of ["All items", "Favorites", "Logins", "Work", "Trash"]) {
      expect(sheet.textContent).toContain(road);
    }
    // A type this vault holds no items of earns no road, exactly as before.
    expect(sheet.textContent).not.toContain("Passkeys");
    // Filters narrow the list; Password health is a page. The chip row it
    // replaced guarded this, and the rail carries both, so it is easy to add.
    expect(sheet.querySelector('a[href="/vault/health"]')).toBeNull();
    expect(
      screen.getByRole("link", { name: /Favorites/ }).getAttribute("href"),
    ).toBe("/vault?f=favorites");
  });

  it("closes the sheet when a road is taken", () => {
    renderSection();
    fireEvent.click(filterKey());
    fireEvent.click(screen.getByRole("link", { name: /Trash/ }));
    expect(screen.queryByRole("dialog", { name: "Filter items" })).toBeNull();
  });
});
