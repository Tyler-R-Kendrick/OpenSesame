/** @vitest-environment jsdom */
import { runtimeFixture } from "@opensesame/app-core/lib/secret-backends/runtime.test-support.js";
import { saveShowHidden } from "@opensesame/app-core/lib/show-hidden.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  filterLink,
  registerContributedShell,
  renderShell,
  resetShellRender,
  seedVault,
} from "../app-shell.test-harness.js";
import { VaultShareProvider } from "../vault-share-seat.js";
import { ContextMenuLayer } from "./ContextMenuLayer.js";

/** Where the shell's router is, so a test can see a menu item navigate. */
function RouteProbe() {
  return <output aria-label="route">{useLocation().pathname}</output>;
}

/**
 * The rail is the filesystem, and it answers a right-click like one: the
 * row's verbs, and a "show hidden items" switch that lists each settings
 * directory's `config.yaml` and the vault's `trash/`.
 */
describe("the rail's context menu", () => {
  let revokeShell: readonly (() => void)[] = [];
  beforeEach(() => {
    revokeShell = registerContributedShell();
    seedVault();
  });
  afterEach(() => {
    act(() => saveShowHidden(false));
    resetShellRender();
    for (const revoke of revokeShell) revoke();
    revokeShell = [];
  });

  function menu() {
    return screen.getByRole("menu");
  }

  it("keeps the browser out of a row's sideways swipe, so no fling eats the first tap", () => {
    renderShell("/vault", <ContextMenuLayer />);
    const row = screen.getByRole("treeitem", { name: "Vault" });
    const touch = (type: string, x: number, y: number) => {
      const event = new Event(type, { bubbles: true, cancelable: true });
      const finger = { identifier: 1, clientX: x, clientY: y, target: row };
      Object.defineProperty(event, "touches", { value: [finger] });
      Object.defineProperty(event, "changedTouches", { value: [finger] });
      row.dispatchEvent(event);
      return event;
    };
    touch("touchstart", 200, 100);
    expect(touch("touchmove", 140, 101).defaultPrevented).toBe(true);
  });

  it("lists trash/ and every config.yaml only once hidden items are shown", () => {
    const { container } = renderShell("/vault", <ContextMenuLayer />);
    expect(container.querySelector('a[href="/vault?f=trash"]')).toBeNull();

    fireEvent.contextMenu(screen.getByRole("treeitem", { name: "Vault" }));
    const toggle = within(menu()).getByRole("menuitemcheckbox", {
      name: "Show hidden items",
    });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(toggle);

    expect(screen.queryByRole("menu")).toBeNull();
    expect(
      filterLink(container, "/vault?f=trash", "trash").textContent,
    ).toContain("1");
    // The settings directory is session-level: the session
    // prompt's menu roots the tree in it, and its own row
    // opens it, before the tab's hidden config.yaml shows.
    const prompt = container.querySelector<HTMLElement>(
      ".app-header .rail__prompt",
    );
    if (!prompt) throw new Error("the header has no session prompt");
    fireEvent.contextMenu(prompt);
    fireEvent.click(within(menu()).getByRole("menuitem", { name: "Settings" }));
    fireEvent.click(screen.getByRole("treeitem", { name: "Settings" }));
    fireEvent.click(screen.getByRole("treeitem", { name: "General" }));
    const config = screen.getByRole("treeitem", { name: "config.yaml" });
    expect(config.getAttribute("href")).toBe("/settings?file=config.yaml");
    expect(config.className).toContain("railtree__row--hidden");

    fireEvent.contextMenu(config);
    expect(
      within(menu())
        .getByRole("menuitemcheckbox", { name: "Show hidden items" })
        .getAttribute("aria-checked"),
    ).toBe("true");
  });

  it("marks where you are in a hidden config.yaml, and Open goes where Enter goes", () => {
    renderShell("/settings/security?file=config.yaml", <ContextMenuLayer />);
    // The directory is closed, so it stands in for the file inside it.
    const security = screen.getByRole("treeitem", { name: "Security" });
    expect(security.getAttribute("aria-selected")).toBe("true");

    // Opened while hidden items were shown, it stays drawn once they are not.
    act(() => saveShowHidden(true));
    fireEvent.click(security);
    fireEvent.click(screen.getByRole("treeitem", { name: "config.yaml" }));
    act(() => saveShowHidden(false));
    const config = screen.getByRole("treeitem", { name: "config.yaml" });
    expect(config.getAttribute("aria-selected")).toBe("true");
    expect(config.getAttribute("data-rail-open")).toBe(
      "/settings/security?file=config.yaml",
    );
  });

  it("offers a settings directory its config.yaml even while it is hidden", () => {
    renderShell("/settings", <ContextMenuLayer />);
    fireEvent.contextMenu(screen.getByRole("treeitem", { name: "Security" }));
    fireEvent.click(
      within(menu()).getByRole("menuitem", { name: "Open config.yaml" }),
    );
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("opens from the keyboard on the cursor row, and Escape hands focus back", () => {
    renderShell("/vault", <ContextMenuLayer />);
    const tree = screen.getByRole("tree", { name: "Sections" });
    tree.focus();
    fireEvent.keyDown(tree, { key: "F10", shiftKey: true });
    const [first] = within(menu()).getAllByRole("menuitem");
    if (!first) throw new Error("the menu has no entries");
    expect(document.activeElement).toBe(first);
    expect(first.getAttribute("aria-label")).toBe("Open");

    fireEvent.keyDown(first, { key: "ArrowDown" });
    const next = document.activeElement;
    expect(next).not.toBe(first);
    fireEvent.keyDown(next ?? document.body, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(tree);
  });

  it("opens on Shift+Enter too, for a keyboard with no F10 or Menu key", () => {
    renderShell("/vault", <ContextMenuLayer />);
    const tree = screen.getByRole("tree", { name: "Sections" });
    tree.focus();
    fireEvent.keyDown(tree, { key: "Enter", shiftKey: true });
    const [first] = within(menu()).getAllByRole("menuitem");
    expect(document.activeElement).toBe(first);
  });

  it("offers password health from the vault's menu, not as a tree row", () => {
    renderShell(
      "/vault",
      <>
        <ContextMenuLayer />
        <RouteProbe />
      </>,
    );
    expect(
      screen.queryByRole("treeitem", { name: "Password health" }),
    ).toBeNull();
    fireEvent.contextMenu(screen.getByRole("treeitem", { name: "Vault" }));
    fireEvent.click(
      within(menu()).getByRole("menuitem", { name: "Password health" }),
    );
    expect(screen.getByLabelText("route").textContent).toBe("/vault/health");
  });

  it("opens Vault Settings from the vault row", () => {
    renderShell(
      "/vault",
      <>
        <ContextMenuLayer />
        <RouteProbe />
      </>,
    );
    fireEvent.contextMenu(screen.getByRole("treeitem", { name: "Vault" }));
    fireEvent.click(
      within(menu()).getByRole("menuitem", { name: "Vault Settings" }),
    );
    expect(screen.getByLabelText("route").textContent).toBe("/settings/vault");
  });

  it("offers password health on the vault only, not on its filters", () => {
    renderShell("/vault", <ContextMenuLayer />);
    fireEvent.contextMenu(screen.getByRole("treeitem", { name: "all" }));
    expect(
      within(menu()).queryByRole("menuitem", { name: "Password health" }),
    ).toBeNull();
    expect(
      within(menu()).getByRole("menuitem", { name: "New item" }),
    ).toBeTruthy();
  });

  it("asks twice before emptying the trash", () => {
    act(() => saveShowHidden(true));
    renderShell("/vault", <ContextMenuLayer />);
    fireEvent.contextMenu(screen.getByRole("treeitem", { name: "trash" }));
    const empty = within(menu()).getByRole("menuitem", { name: "Empty trash" });
    fireEvent.click(empty);
    expect(
      within(menu()).getByRole("menuitem", {
        name: "Really empty trash? This cannot be undone",
      }),
    ).toBeTruthy();
  });

  it("roots the tree in a session directory from the session prompt's menu", () => {
    const { container } = renderShell("/vault", <ContextMenuLayer />);
    // The two session-level directories are not rail rows.
    expect(screen.queryByRole("treeitem", { name: "Settings" })).toBeNull();
    expect(screen.queryByRole("treeitem", { name: "Activity" })).toBeNull();
    // The session prompt is the home of the two the rail leaves
    // out: a right-click roots the tree in either one.
    const prompt = container.querySelector<HTMLElement>(
      ".app-header .rail__prompt",
    );
    if (!prompt) throw new Error("the header has no session prompt");
    fireEvent.contextMenu(prompt);
    // Both session directories are offered.
    const settings = within(menu()).getByRole("menuitem", {
      name: "Settings",
    });
    within(menu()).getByRole("menuitem", { name: "Activity" });
    fireEvent.click(settings);
    expect(screen.queryByRole("menu")).toBeNull();
    // The tree is rooted in settings: a back key to the vault and
    // the settings directory, with no vault directory beside them.
    expect(
      screen.getByRole("treeitem", { name: "Back to vault" }),
    ).toBeTruthy();
    const settingsRow = screen.getByRole("treeitem", { name: "Settings" });
    expect(settingsRow).toBeTruthy();
    expect(screen.queryByRole("treeitem", { name: "Vault" })).toBeNull();
    // Opening the rooted directory lists its categories.
    fireEvent.click(settingsRow);
    expect(
      container.querySelector('a[href="/settings/security"]'),
    ).toBeTruthy();
    // The back key returns the tree to the vault view.
    fireEvent.click(screen.getByRole("treeitem", { name: "Back to vault" }));
    expect(screen.getByRole("treeitem", { name: "Vault" })).toBeTruthy();
    expect(
      screen.queryByRole("treeitem", { name: "Back to vault" }),
    ).toBeNull();
  });
});

/**
 * Share › Live session hands this vault to people who open a link, so it
 * opens the share sheet that hosts one. `/live` is the other side of that link —
 * the join screen — and is never where an owner broadcasts from.
 */
describe("the vault row's Share › Live session entry", () => {
  let revokeShell: readonly (() => void)[] = [];
  beforeEach(() => {
    revokeShell = registerContributedShell();
    seedVault();
  });
  afterEach(() => {
    for (const revoke of revokeShell) revoke();
    revokeShell = [];
    resetShellRender();
  });

  /** Live sessions on: the Share key's seat is filled, as the wrapper fills it. */
  const shareOpen = vi.fn();

  function Where() {
    const { pathname, hash } = useLocation();
    return <output data-testid="where">{`${pathname}${hash}`}</output>;
  }

  function openShareSession() {
    shareOpen.mockClear();
    renderShell(
      "/vault",
      <VaultShareProvider value={{ Button: () => null, open: shareOpen }}>
        <Where />
        <ContextMenuLayer />
      </VaultShareProvider>,
    );
    fireEvent.contextMenu(screen.getByRole("treeitem", { name: "Vault" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Share/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Live session" }));
  }

  it("opens the share sheet that hosts a live session, not the join screen", () => {
    openShareSession();
    expect(shareOpen).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("where").textContent).toBe("/vault");
  });

  it("offers no Live session while Live sessions is off", async () => {
    const disk = await runtimeFixture();
    try {
      expect(vaultStore.getSnapshot().status).toBe("unlocked");
      renderShell("/vault", <ContextMenuLayer />);
      fireEvent.contextMenu(screen.getByRole("treeitem", { name: "Vault" }));
      // Access is still on, so Share is drawn — without the session way.
      fireEvent.click(screen.getByRole("menuitem", { name: /Share/ }));
      expect(
        screen.getByRole("menuitem", { name: "Temporary drop" }),
      ).toBeTruthy();
      expect(
        screen.getByRole("menuitem", { name: "Specific people or agents" }),
      ).toBeTruthy();
      expect(
        screen.queryByRole("menuitem", { name: "Live session" }),
      ).toBeNull();
    } finally {
      await disk.close();
    }
  });
});

describe("the page's context menu", () => {
  afterEach(() => resetShellRender());

  it("offers a settings tab its directory's config.yaml, and the page's verbs", () => {
    render(
      <MemoryRouter initialEntries={["/settings"]}>
        <a href="/settings/security">Security</a>
        <p>plain text</p>
        <ContextMenuLayer />
      </MemoryRouter>,
    );
    fireEvent.contextMenu(screen.getByText("Security"));
    const menu = screen.getByRole("menu", { name: "Page actions" });
    expect(
      within(menu)
        .getAllByRole("menuitem")
        .map((item) => item.getAttribute("aria-label")),
    ).toEqual([
      "Open config.yaml",
      "Open link",
      "Open link in new tab",
      "Copy link address",
      "Back",
      "Forward",
      "Reload",
    ]);
    fireEvent.keyDown(document.activeElement ?? document.body, {
      key: "Escape",
    });
    fireEvent.contextMenu(screen.getByText("plain text"));
    expect(
      within(screen.getByRole("menu")).queryByRole("menuitem", {
        name: "Open config.yaml",
      }),
    ).toBeNull();
  });

  it("leaves a text field the browser's own menu", () => {
    render(
      <MemoryRouter>
        <input aria-label="field" />
        <ContextMenuLayer />
      </MemoryRouter>,
    );
    const event = new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
    });
    screen.getByLabelText("field").dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    expect(screen.queryByRole("menu")).toBeNull();
  });
});
