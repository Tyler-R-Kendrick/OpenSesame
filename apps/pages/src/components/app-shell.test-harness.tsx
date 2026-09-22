/**
 * The harness both AppShell suites render through.
 *
 * It owns the seams the shell reads (vault hooks, the two status bars, the
 * account and project switchers, crumbs), the three-item vault fixture, and
 * the DOM readers a suite uses to inspect the rail. Split out of
 * `AppShell.test.tsx` when that file crossed the module-size budget; the
 * suites keep their own lifecycle hooks. Test support: never imported by
 * the app.
 */

import { cleanup, render } from "@testing-library/react";
import { screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router";
import { vi } from "vitest";
import { setRailCursor } from "./rail-cursor.js";

type FixtureItem = {
  kind: string;
  deletedAt: string | null;
  favorite: boolean;
  folderId: string | null;
};

/** The vault the seams read, mutable so a case can empty or refill it. */
export const vault: {
  items: FixtureItem[];
  folders: Array<{ id: string; name: string }>;
  lock: ReturnType<typeof vi.fn>;
} = { items: [], folders: [], lock: vi.fn() };

import { vaultHooksSeams } from "../lib/vault/hooks.js";
Object.assign(vaultHooksSeams, {
  useVault: () => ({
    items: vault.items,
    folders: vault.folders,
    prefs: {
      theme: "system",
      autoLockMinutes: 0,
      clipboardClearSeconds: 30,
      lockOnHide: false,
      signOutOnLock: false,
    },
  }),
  useVaultStore: () => ({ lock: vault.lock }),
});

import { connectivityBarSeams } from "./ConnectivityBar.js";
Object.assign(connectivityBarSeams, {
  ConnectivityBar: () => <span data-testid="connectivity-bar" />,
});
import { notificationsBarSeams } from "./NotificationsBar.js";
Object.assign(notificationsBarSeams, {
  NotificationsBar: () => <span data-testid="notifications-bar" />,
});
import { projectSwitcherSeams } from "./ProjectSwitcher.js";
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

import { IDENTITY_VIEWS } from "../lib/section-views.js";
import { contributeIdentityViews } from "../sections/identity/identity-views.js";
import { AppShell } from "./AppShell.js";
import { registerLegacyShell } from "./legacy-sections.test-support.js";

export const ITEMS = [
  { kind: "login", deletedAt: null, favorite: true, folderId: "f1" },
  { kind: "login", deletedAt: null, favorite: false, folderId: null },
  {
    kind: "card",
    deletedAt: "2025-06-01T00:00:00Z",
    favorite: false,
    folderId: "f1",
  },
];

export function renderShell(
  route: string,
  children: ReactNode = <p>content</p>,
) {
  return render(
    <MemoryRouter initialEntries={[route]}>
      <AppShell>{children}</AppShell>
    </MemoryRouter>,
  );
}

/** The fixture vault every suite starts a test from. */
export function seedVault(): void {
  vault.items = [...ITEMS.map((item) => ({ ...item }))];
  vault.folders = [{ id: "f1", name: "Work" }];
  vault.lock.mockReset();
}

/** The shell as the optional modules register it on activation. */
export function registerContributedShell(): readonly (() => void)[] {
  return [registerLegacyShell(), contributeIdentityViews(IDENTITY_VIEWS)];
}

export function resetShellRender(): void {
  setRailCursor(null);
  cleanup();
}

export function filterLink(
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

export function selected(name: string) {
  return screen.getByRole("treeitem", { name }).getAttribute("aria-selected");
}
