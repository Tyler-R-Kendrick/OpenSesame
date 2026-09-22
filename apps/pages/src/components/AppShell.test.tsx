/** @vitest-environment jsdom */
import { fireEvent, screen } from "@testing-library/react";
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
 * only their jumps, and Settings has only its five core categories.
 */
describe("AppShell on a core-only plan", () => {
  beforeEach(seedVault);
  afterEach(resetShellRender);

  it("draws the two core rail directories and nothing a capability owns", () => {
    const { container } = renderShell("/vault");
    const rows = [
      ...container.querySelectorAll<HTMLElement>(
        '.railtree > [role="treeitem"]',
      ),
    ].map((row) => row.getAttribute("aria-label"));
    expect(rows).toEqual(["Vault", "Settings"]);
    for (const gone of ["Connections", "Access", "Identity", "Wallet"]) {
      expect(screen.queryByText(gone.toLowerCase())).toBeNull();
    }
    const jumps = [...container.querySelectorAll("kbd.railtree__jump")].map(
      (kbd) => kbd.textContent,
    );
    expect(jumps).toEqual(["gv", "gs"]);
  });

  it("names the same two sections in the phone drawer", () => {
    renderShell("/vault");
    fireEvent.click(screen.getByRole("button", { name: "Sections" }));
    const drawer = screen.getByRole("dialog", { name: "Sections" });
    expect(
      [...drawer.querySelectorAll(".drawer__name")].map((n) => n.textContent),
    ).toEqual(["Vault", "Settings"]);
  });

  it("lists the five core Settings categories and no contributed one", () => {
    const { container } = renderShell("/settings/security");
    const rail = container.querySelector(".railtree");
    const tabs = [
      ...(rail?.querySelectorAll<HTMLAnchorElement>(
        'a[href^="/settings"][aria-level="2"]',
      ) ?? []),
    ].map((a) => a.getAttribute("href"));
    expect(tabs).toEqual([
      "/settings",
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
    expect(filters).toContain("/vault?f=login");
    expect(filters).toContain("/vault?f=card");
    expect(filters).toContain("/vault?f=secret");
    expect(filters).toContain("/vault?f=note");
    expect(filters).not.toContain("/vault?f=passkey");
    expect(filters).not.toContain("/vault?f=certificate");
    expect(filters).not.toContain("/vault?f=drop");
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
    const labels = [
      "Vault",
      "Connections",
      "Access",
      "Identity",
      "Wallet",
      "Activity",
      "Settings",
    ];
    for (const label of labels) {
      expect(screen.getAllByText(label.toLowerCase()).length).toBe(1);
    }
    expect(labels.flatMap((l) => screen.queryAllByText(l))).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Sections" }));
    expect(labels.flatMap((l) => screen.queryAllByText(l))).toHaveLength(7);
    const gone = ["Authority", "Authentication", "Sites"];
    expect(gone.flatMap((g) => screen.queryAllByText(g))).toHaveLength(0);
    expect(screen.getByText("content")).toBeTruthy();
    expect(screen.getAllByTestId("project-switcher").length).toBe(2);
    expect(screen.getAllByTestId("account-switcher").length).toBe(2);
    expect(screen.getAllByTestId("connectivity-bar").length).toBe(1);
    expect(screen.getAllByTestId("notifications-bar").length).toBe(1);
    expect(screen.queryByTestId("backup-banner")).toBeNull();
  });
  it("advertises the g-jump key on every section directory", () => {
    const { container } = renderShell("/vault");
    const jumps = [...container.querySelectorAll("kbd.railtree__jump")].map(
      (kbd) => kbd.textContent,
    );
    expect(jumps).toEqual(["gv", "gc", "ga", "gi", "gw", "gy", "gs"]);
  });
  it("lists Vaults and Connections as sibling settings tabs", () => {
    const { container } = renderShell("/settings/security");
    const rail = container.querySelector(".railtree");
    const vaults = rail?.querySelector('a[href="/settings/vaults"]');
    const connections = rail?.querySelector('a[href="/settings/connections"]');
    expect(vaults?.getAttribute("aria-level")).toBe("2");
    expect(connections?.getAttribute("aria-level")).toBe("2");
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
    expect(
      container.querySelector('a[href="/vault?f=login&folder=f1"]'),
    ).toBeNull();
    expect(screen.queryByText("all")).toBeNull();
    expect(screen.getAllByText("settings").length).toBe(1);
  });
  it("omits folder entries when there are none", () => {
    vault.folders = [];
    const { container } = renderShell("/vault");
    expect(container.querySelector('a[href="/vault?folder=f1"]')).toBeNull();
  });
  it.each(["/vault", "/vault/health"])(
    "keeps health out of the tree on %s",
    (path) => {
      renderShell(path);
      const tree = screen.getByRole("tree", { name: "Sections" });
      expect(tree.querySelector('a[href="/vault/health"]')).toBeNull();
      expect(
        document.getElementById(
          tree.getAttribute("aria-activedescendant") ?? "",
        ),
      ).not.toBeNull();
    },
  );
  it("groups lock with account and vault switching on desktop and phone", () => {
    const { container } = renderShell("/vault");
    const locks = screen.getAllByRole("button", { name: "Lock vault" });
    expect(locks).toHaveLength(2);
    expect(
      container.querySelector('.statusline [aria-label="Lock vault"]'),
    ).toBeNull();
    for (const lock of locks) {
      const prompt = lock.closest(".rail__prompt");
      expect(
        prompt?.querySelector('[data-testid="account-switcher"]'),
      ).toBeTruthy();
      expect(
        prompt?.querySelector('[data-testid="project-switcher"]'),
      ).toBeTruthy();
      fireEvent.click(lock);
    }
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
