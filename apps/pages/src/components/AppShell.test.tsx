import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router";
/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const vault = vi.hoisted(() => {
  const items: Array<{
    kind: string;
    deletedAt: string | null;
    favorite: boolean;
    folderId: string | null;
  }> = [];
  const folders: Array<{ id: string; name: string }> = [];
  return { items, folders, lock: vi.fn() };
});

import { vaultHooksSeams } from "../lib/vault/hooks.js";
const originalVaultHooksSeams = { ...vaultHooksSeams };
Object.assign(vaultHooksSeams, {
  useVault: () => ({ items: vault.items, folders: vault.folders }),
  useVaultStore: () => ({ lock: vault.lock }),
});

import { connectivityBarSeams } from "./ConnectivityBar.js";
const originalConnectivityBarSeams = { ...connectivityBarSeams };
Object.assign(connectivityBarSeams, {
  ConnectivityBar: () => <span data-testid="connectivity-bar" />,
});
import { notificationsBarSeams } from "./NotificationsBar.js";
Object.assign(notificationsBarSeams, {
  NotificationsBar: () => <span data-testid="notifications-bar" />,
});
import { planeNoteSeams } from "./PlaneNote.js";
const originalPlaneNoteSeams = { ...planeNoteSeams };
Object.assign(planeNoteSeams, {
  RailPlaneStatus: () => <span data-testid="plane-status" />,
});

import { projectSwitcherSeams } from "./ProjectSwitcher.js";
const originalProjectSwitcherSeams = { ...projectSwitcherSeams };
Object.assign(projectSwitcherSeams, {
  ProjectSwitcher: () => <span data-testid="project-switcher" />,
});

import { accountSwitcherSeams } from "./AccountSwitcher.js";
Object.assign(accountSwitcherSeams, {
  AccountSwitcher: () => <span data-testid="account-switcher" />,
});

import { crumbsSeams } from "./Crumbs.js";
Object.assign(crumbsSeams, {
  Crumbs: () => <nav data-testid="crumbs" aria-label="Breadcrumb" />,
});

import { AppShell } from "./AppShell.js";

function renderShell(route: string, children: ReactNode = <p>content</p>) {
  return render(
    <MemoryRouter initialEntries={[route]}>
      <AppShell>{children}</AppShell>
    </MemoryRouter>,
  );
}

const ITEMS = [
  { kind: "login", deletedAt: null, favorite: true, folderId: "f1" },
  { kind: "login", deletedAt: null, favorite: false, folderId: null },
  {
    kind: "card",
    deletedAt: "2025-06-01T00:00:00Z",
    favorite: false,
    folderId: "f1",
  },
];

function filterLink(
  container: HTMLElement,
  href: string,
  label: string,
): HTMLAnchorElement {
  const matches = [
    ...container.querySelectorAll<HTMLAnchorElement>(`a[href="${href}"]`),
  ].filter((a) => a.textContent?.includes(label));
  if (matches.length !== 1) {
    throw new Error(`expected one filter link ${href} containing "${label}"`);
  }
  return matches[0];
}

describe("AppShell", () => {
  beforeEach(() => {
    vault.items = [...ITEMS.map((item) => ({ ...item }))];
    vault.folders = [{ id: "f1", name: "Work" }];
    vault.lock.mockReset();
  });

  afterEach(cleanup);

  it("renders brand, section navigation, and children", () => {
    renderShell("/vault");
    expect(screen.getAllByText("OpenSesame").length).toBeGreaterThan(0);
    // The rail reads sections as directories; the mobile tab bar keeps labels.
    for (const segment of ["connections", "access", "identity", "settings"]) {
      expect(screen.getAllByText(segment).length).toBe(1);
    }
    for (const label of ["Connections", "Access", "Identity", "Settings"]) {
      expect(screen.getAllByText(label).length).toBe(1);
    }
    // The removed screens leave no nav entries behind.
    expect(screen.queryByText("Authority")).toBeNull();
    expect(screen.queryByText("Authentication")).toBeNull();
    expect(screen.queryByText("Sites")).toBeNull();
    expect(screen.getAllByText("vault").length).toBe(1);
    expect(screen.getAllByText("Vault").length).toBe(1);
    expect(screen.getByText("content")).toBeTruthy();
    expect(screen.getAllByTestId("project-switcher").length).toBe(2);
    expect(screen.getAllByTestId("account-switcher").length).toBe(2);
    // One per chrome: the phone top bar and the desktop statusline both
    // carry plane truth; CSS shows exactly one per breakpoint.
    expect(screen.getAllByTestId("connectivity-bar").length).toBe(2);
    expect(screen.getAllByTestId("notifications-bar").length).toBe(2);
    expect(screen.queryByTestId("backup-banner")).toBeNull();
  });

  it("advertises the g-jump key on every section directory", () => {
    const { container } = renderShell("/vault");
    const jumps = [...container.querySelectorAll("kbd.railtree__jump")].map(
      (kbd) => kbd.textContent,
    );
    expect(jumps).toEqual(["gv", "gc", "ga", "gi", "gs"]);
  });

  it("hangs the settings categories under settings/ when inside", () => {
    const { container } = renderShell("/settings/security");
    const security = container.querySelector('a[href="/settings/security"]');
    expect(security?.textContent).toBe("security");
    expect(security?.className).toContain("is-active");
    expect(
      container.querySelector('a[href="/settings/data"]')?.textContent,
    ).toBe("data");
  });

  it("counts live items, favourites, trash, and kinds in the vault filters", () => {
    const { container } = renderShell("/vault");

    const all = filterLink(container, "/vault", "all");
    expect(all.textContent).toContain("2");

    const favorites = filterLink(container, "/vault?f=favorites", "favorites");
    expect(favorites.textContent).toContain("1");

    const logins = filterLink(container, "/vault?f=login", "logins");
    expect(logins.textContent).toContain("2");

    // The deleted card does not count towards the live kind count.
    const cards = filterLink(container, "/vault?f=card", "cards");
    expect(cards.textContent).toContain("0");

    const trash = filterLink(container, "/vault?f=trash", "trash");
    expect(trash.textContent).toContain("1");
  });

  it("lists folders with their live item counts", () => {
    const { container } = renderShell("/vault");
    const folder = filterLink(container, "/vault?folder=f1", "Work");
    // Only the live login counts; the deleted card does not.
    expect(folder.textContent).toContain("1");
  });

  it("marks the active filter from the query string", () => {
    const { container } = renderShell("/vault?f=favorites");
    expect(
      filterLink(container, "/vault?f=favorites", "favorites").className,
    ).toContain("is-active");
    expect(filterLink(container, "/vault", "all").className).not.toContain(
      "is-active",
    );
  });

  it("marks the active folder and deactivates 'all'", () => {
    const { container } = renderShell("/vault?folder=f1");
    expect(
      filterLink(container, "/vault?folder=f1", "Work").className,
    ).toContain("is-active");
    expect(filterLink(container, "/vault", "all").className).not.toContain(
      "is-active",
    );
  });

  it("marks 'all' active only with no filter at all", () => {
    const { container } = renderShell("/vault");
    expect(filterLink(container, "/vault", "all").className).toContain(
      "is-active",
    );
  });

  it("hides vault entries outside the vault section", () => {
    const { container } = renderShell("/access");
    expect(container.querySelector('a[href="/vault?f=trash"]')).toBeNull();
    expect(container.querySelector('a[href="/vault?folder=f1"]')).toBeNull();
    expect(screen.queryByText("all")).toBeNull();
    // The section directories stay.
    expect(screen.getAllByText("settings").length).toBe(1);
  });

  it("omits folder entries when there are none", () => {
    vault.folders = [];
    const { container } = renderShell("/vault");
    expect(container.querySelector('a[href="/vault?folder=f1"]')).toBeNull();
  });

  it("offers the password-health review entry", () => {
    const { container } = renderShell("/vault");
    const health = container.querySelector('a[href="/vault/health"]');
    expect(health?.textContent).toContain("health");
  });

  it("both lock buttons call the store lock", () => {
    renderShell("/vault");
    // One in the phone top bar, one in the desktop statusline.
    const locks = screen.getAllByRole("button", { name: "Lock" });
    expect(locks).toHaveLength(2);
    for (const lock of locks) fireEvent.click(lock);
    expect(vault.lock).toHaveBeenCalledTimes(2);
  });

  it("offers a skip-to-content link as the first stop", () => {
    const { container } = renderShell("/vault");
    const skip = screen.getByRole("link", { name: "Skip to content" });
    expect(skip.getAttribute("href")).toBe("#main");
    expect(skip.className).toContain("visually-hidden");
    // First in DOM order, so it is the first stop of a keyboard pass.
    expect(container.querySelector("a, button")).toBe(skip);
  });

  it("handles vaults with no folders and no items", () => {
    vault.items = [];
    vault.folders = [];
    const { container } = renderShell("/vault");
    expect(filterLink(container, "/vault", "all").textContent).toContain("0");
  });

  it("captures section shortcuts before the tree can stop propagation", () => {
    renderShell(
      "/vault",
      <button type="button" onKeyDown={(event) => event.stopPropagation()}>
        tree row
      </button>,
    );
    const row = screen.getByRole("button", { name: "tree row" });
    row.focus();
    fireEvent.keyDown(row, { key: "g" });
    fireEvent.keyDown(row, { key: "a" });
    expect(screen.queryByText("all")).toBeNull();
  });
});
