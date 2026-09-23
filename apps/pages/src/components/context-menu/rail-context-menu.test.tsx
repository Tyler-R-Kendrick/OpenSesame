/** @vitest-environment jsdom */
import { saveShowHidden } from "@opensesame/app-core/lib/show-hidden.js";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  filterLink,
  registerContributedShell,
  renderShell,
  resetShellRender,
  seedVault,
} from "../app-shell.test-harness.js";
import { ContextMenuLayer } from "./ContextMenuLayer.js";

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
