/** @vitest-environment jsdom */
import { fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  registerContributedShell,
  renderShell,
  resetShellRender,
  seedVault,
  vault,
} from "./app-shell.test-harness.js";

/**
 * SURFACE-01/02/03. Every ordinary surface of the shell derives from
 * contributions: with nothing registered the rail is the two core
 * directories, the drawer names the same two, the keymap sheet advertises
 * only their jumps, and Settings has only its six core categories.
 */
describe("AppShell on a core-only plan", () => {
  beforeEach(seedVault);
  afterEach(resetShellRender);

  it("draws the vault rail directory and nothing a capability owns", () => {
    const { container } = renderShell("/vault");
    const rows = [
      ...container.querySelectorAll<HTMLElement>(
        '.railtree > [role="treeitem"]',
      ),
    ].map((row) => row.getAttribute("aria-label"));
    // Settings is core but session-level: the session
    // prompt's menu roots the tree in it, so it is not a
    // rail row.
    expect(rows).toEqual(["Vault"]);
    for (const gone of [
      "Connections",
      "Access",
      "Identity",
      "Wallet",
      "Settings",
    ]) {
      expect(screen.queryByText(gone.toLowerCase())).toBeNull();
    }
    const jumps = [...container.querySelectorAll("kbd.railtree__jump")].map(
      (kbd) => kbd.textContent,
    );
    expect(jumps).toEqual(["gv"]);
  });

  it("names the core sections and closes the phone drawer after navigation", () => {
    renderShell("/vault");
    fireEvent.click(screen.getByRole("button", { name: "Sections" }));
    const drawer = screen.getByRole("dialog", { name: "Sections" });
    expect(
      [...drawer.querySelectorAll(".drawer__name")].map((n) => n.textContent),
    ).toEqual(["Vault", "Settings"]);
    fireEvent.click(within(drawer).getByRole("link", { name: "Settings" }));
    expect(screen.queryByRole("dialog", { name: "Sections" })).toBeNull();
    expect(
      document.querySelector(".mobile-toolbar__section")?.textContent,
    ).toBe("Settings");
  });

  it("lists the six core Settings categories and no contributed one", () => {
    const { container } = renderShell("/settings/security");
    const rail = container.querySelector(".railtree");
    const tabs = [
      ...(rail?.querySelectorAll<HTMLAnchorElement>(
        'a[href^="/settings"][aria-level="2"]',
      ) ?? []),
    ].map((a) => a.getAttribute("href"));
    expect(tabs).toEqual([
      "/settings",
      "/settings/keybindings",
      "/settings/security",
      "/settings/vaults",
      "/settings/capabilities",
      "/settings/danger",
    ]);
    expect(rail?.querySelector('a[href="/settings/connections"]')).toBeNull();
  });

  it("offers only the core item kinds in the vault filters", () => {
    const { container } = renderShell("/vault");
    const filters = [
      ...container.querySelectorAll<HTMLAnchorElement>('a[href^="/vault?f="]'),
    ].map((a) => a.getAttribute("href"));
    expect(filters).toEqual([
      "/vault?f=favorites",
      "/vault?f=secret",
      "/vault?f=file",
    ]);
  });
});

describe("AppShell", () => {
  let revokeShell: readonly (() => void)[] = [];
  beforeEach(() => {
    revokeShell = registerContributedShell();
    seedVault();
  });
  afterEach(() => {
    resetShellRender();
    for (const revoke of revokeShell) revoke();
    revokeShell = [];
  });
  it("renders brand, section navigation, and children", () => {
    renderShell("/vault");
    expect(screen.getAllByText("open-sesame").length).toBeGreaterThan(0);
    expect(screen.getByLabelText("Command")).toBeTruthy();
    expect(screen.queryByPlaceholderText("Questions only")).toBeNull();
    // The rail's lowercase segments are always drawn; the capitalised labels
    // are the phone's, and a phone keeps its sections behind one key.
    // The two session-level directories are not rail rows — the
    // session prompt's menu roots the tree in them — but the
    // phone drawer still names them, so a phone keeps its road.
    const railLabels = ["Vault", "Connections", "Access", "Identity", "Wallet"];
    for (const label of railLabels) {
      expect(screen.getAllByText(label.toLowerCase()).length).toBe(1);
    }
    for (const session of ["activity", "settings"]) {
      expect(screen.queryAllByText(session)).toHaveLength(0);
    }
    expect(document.querySelectorAll(".drawer__name")).toHaveLength(0);
    expect(
      document.querySelector(".mobile-toolbar__section")?.textContent,
    ).toBe("Vault");
    const drawerLabels = [...railLabels, "Activity", "Settings"];
    fireEvent.click(screen.getByRole("button", { name: "Sections" }));
    expect(
      [...document.querySelectorAll(".drawer__name")].map(
        (row) => row.textContent,
      ),
    ).toEqual(drawerLabels);
    const gone = ["Authority", "Authentication", "Sites"];
    expect(gone.flatMap((g) => screen.queryAllByText(g))).toHaveLength(0);
    expect(screen.getByText("content")).toBeTruthy();
    expect(screen.getAllByTestId("project-switcher").length).toBe(2);
    expect(screen.getAllByTestId("account-switcher").length).toBe(2);
    expect(screen.queryByTestId("connectivity-bar")).toBeNull();
    expect(screen.getAllByTestId("notifications-bar").length).toBe(1);
    expect(screen.queryByTestId("backup-banner")).toBeNull();
  });
  it("advertises the g-jump key on every section directory", () => {
    const { container } = renderShell("/vault");
    const jumps = [...container.querySelectorAll("kbd.railtree__jump")].map(
      (kbd) => kbd.textContent,
    );
    // The g-jump keys for the two session-level directories
    // (g y, g s) are advertised on the session prompt's
    // menu entries, not on rail rows — neither is a rail
    // directory.
    expect(jumps).toEqual(["gv", "gc", "ga", "gi", "gw"]);
  });
  it("lists Vaults and Capabilities as sibling settings tabs, with no Connections tab", () => {
    const { container } = renderShell("/settings/security");
    const rail = container.querySelector(".railtree");
    const vaults = rail?.querySelector('a[href="/settings/vaults"]');
    const capabilities = rail?.querySelector(
      'a[href="/settings/capabilities"]',
    );
    expect(vaults?.getAttribute("aria-level")).toBe("2");
    expect(capabilities?.getAttribute("aria-level")).toBe("2");
    expect(rail?.querySelector('a[href="/settings/connections"]')).toBeNull();
  });
  it.each([
    ["/vault?f=favorites", "Vault", "favorites"],
    ["/settings/security", "Settings", "Security"],
    ["/identity?view=agents", "Identity", "Agents"],
    ["/access?view=sessions", "Access", "Sessions"],
  ])(
    "toggles the %s branch without losing the selected child",
    (route, label, child) => {
      const { container } = renderShell(route);
      const row = screen.getByRole("treeitem", { name: label });
      const tree = screen.getByRole("tree", { name: "Sections" });
      expect(row.getAttribute("aria-expanded")).toBe("true");
      fireEvent.click(row);
      expect(row.getAttribute("aria-expanded")).toBe("false");
      expect(container.querySelector(".railtree__kids")).toBeNull();
      expect(tree.getAttribute("aria-activedescendant")).toBe(row.id);
      fireEvent.click(row);
      expect(row.getAttribute("aria-expanded")).toBe("true");
      expect(container.querySelector(".railtree__kids")?.textContent).toContain(
        child,
      );
    },
  );
  it("hides vault entries outside the vault section", () => {
    const { container } = renderShell("/access");
    expect(container.querySelector('a[href="/vault?f=trash"]')).toBeNull();
    expect(container.querySelector('a[href="/vault/health"]')).toBeNull();
    expect(
      container.querySelector('a[href="/vault?f=account&folder=f1"]'),
    ).toBeNull();
    expect(screen.queryByText("all")).toBeNull();
    expect(screen.getAllByText("connections").length).toBe(1);
  });
  it("omits folder entries when there are none", () => {
    vault.folders = [];
    const { container } = renderShell("/vault");
    expect(container.querySelector('a[href="/vault?folder=f1"]')).toBeNull();
  });
  it.each(["/vault", "/vault/health"])(
    "lists password health in the vault tree on %s",
    (path) => {
      renderShell(path);
      const tree = screen.getByRole("tree", { name: "Sections" });
      const health = tree.querySelector('a[href="/vault/health"]');
      expect(health?.getAttribute("aria-label")).toBe("Password health");
      expect(health?.textContent).toContain("health");
      expect(
        document.getElementById(
          tree.getAttribute("aria-activedescendant") ?? "",
        ),
      ).not.toBeNull();
    },
  );
  it("keeps lock in the mobile header and switching in its drawer", () => {
    const { container } = renderShell("/vault");
    const locks = screen.getAllByRole("button", { name: "Lock vault" });
    expect(locks).toHaveLength(2);
    expect(
      container.querySelector('.statusline [aria-label="Lock vault"]'),
    ).toBeNull();
    const header = container.querySelector(".mobile-toolbar");
    expect(header?.querySelectorAll("button")).toHaveLength(3);
    expect(
      header?.querySelector('[data-testid="account-switcher"]'),
    ).toBeNull();
    expect(
      header?.querySelector('[data-testid="project-switcher"]'),
    ).toBeNull();
    const desktop = container.querySelector(".rail__prompt");
    expect(
      desktop?.querySelector('[data-testid="account-switcher"]'),
    ).toBeTruthy();
    expect(
      desktop?.querySelector('[data-testid="project-switcher"]'),
    ).toBeTruthy();
    for (const lock of locks) fireEvent.click(lock);
    expect(vault.lock).toHaveBeenCalledTimes(2);
  });
  it("offers a skip-to-content link as the first stop", () => {
    const { container } = renderShell("/vault");
    const skip = screen.getByRole("link", { name: "Skip to content" });
    expect(skip.getAttribute("href")).toBe("#main");
    expect(skip.className).toContain("visually-hidden");
    expect(container.querySelector("a, button")).toBe(skip);
  });
});
