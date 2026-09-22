/** @vitest-environment jsdom */
import { fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  filterLink,
  registerContributedShell,
  renderShell,
  resetShellRender,
  seedVault,
  selected,
  vault,
} from "./app-shell.test-harness.js";

/**
 * The rail's own behaviour: which entry is selected, what the counts say, and
 * how the keyboard walks the tree. Split from `AppShell.test.tsx`, which keeps
 * the structural contract (which directories, tabs and jumps a plan draws).
 */

describe("AppShell rail navigation", () => {
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
  it("collapses and reopens a section with the arrow keys", () => {
    renderShell("/vault?f=favorites");
    const tree = screen.getByRole("tree", { name: "Sections" });
    const row = screen.getByRole("treeitem", { name: "Vault" });
    tree.focus();
    fireEvent.keyDown(tree, { key: "ArrowLeft" });
    expect(row.getAttribute("aria-expanded")).toBe("false");
    fireEvent.keyDown(tree, { key: "ArrowRight" });
    expect(row.getAttribute("aria-expanded")).toBe("true");
    expect(row.getAttribute("aria-selected")).toBe("true");
  });
  it("collapses and reopens a page subtree with the arrow keys", () => {
    renderShell("/access?view=grants");
    const tree = screen.getByRole("tree", { name: "Sections" });
    const grants = screen.getByRole("treeitem", { name: "Grants" });
    const access = screen.getByRole("treeitem", { name: "Access" });
    tree.focus();
    expect(grants.getAttribute("aria-expanded")).toBe("false");
    fireEvent.keyDown(tree, { key: "ArrowUp" });
    expect(access.getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(tree, { key: "ArrowDown" });
    expect(grants.getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(tree, { key: "ArrowRight" });
    expect(grants.getAttribute("aria-expanded")).toBe("true");
    fireEvent.keyDown(tree, { key: "ArrowLeft" });
    expect(grants.getAttribute("aria-expanded")).toBe("false");
    expect(document.getElementById("grants-tree")).toBeNull();
    fireEvent.keyDown(tree, { key: "ArrowRight" });
    expect(grants.getAttribute("aria-expanded")).toBe("true");
    expect(document.getElementById("grants-tree")).toBeTruthy();
  });
  it("counts live items, favourites, trash, and kinds in the vault filters", () => {
    const { container } = renderShell("/vault");
    const all = filterLink(container, "/vault", "all");
    expect(all.textContent).toContain("2");
    const favorites = filterLink(container, "/vault?f=favorites", "favorites");
    expect(favorites.textContent).toContain("1");
    const logins = filterLink(container, "/vault?f=login", "logins");
    expect(logins.textContent).toContain("2");
    const cards = filterLink(container, "/vault?f=card", "cards");
    expect(cards.textContent).toContain("-");
    const trash = filterLink(container, "/vault?f=trash", "trash");
    expect(trash.textContent).toContain("1");
  });
  it("lists folders with their live item counts", () => {
    const { container } = renderShell("/vault");
    fireEvent.click(screen.getByRole("treeitem", { name: "logins" }));
    const folder = filterLink(container, "/vault?f=login&folder=f1", "Work");
    // Only the live login counts; the deleted card does not.
    expect(folder.textContent).toContain("1");
    expect(folder.closest("#login-tree")).toBeTruthy();
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
    fireEvent.click(screen.getByRole("treeitem", { name: "logins" }));
    expect(
      container.querySelector('a[href="/vault?f=login&folder=f1"]'),
    ).toBeTruthy();
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
  it("handles vaults with no folders and no items", () => {
    vault.items = [];
    vault.folders = [];
    const { container } = renderShell("/vault");
    expect(filterLink(container, "/vault", "all").textContent).toContain("-");
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
    fireEvent.keyDown(row, { key: "s" });
    expect(selected("Settings")).toBe("true");
    fireEvent.keyDown(row, { key: "g" });
    fireEvent.keyDown(row, { key: "v" });
    expect(selected("Vault")).toBe("true");
    fireEvent.keyDown(row, { key: "j" });
    expect(selected("Settings")).toBe("false");
  });
  it("moves the rail cursor with arrows and j/k", () => {
    const { container } = renderShell("/vault");
    const tree = screen.getByRole("tree", { name: "Sections" });
    tree.focus();
    fireEvent.keyDown(tree, { key: "ArrowDown" });
    expect(
      filterLink(container, "/vault?f=favorites", "favorites").className,
    ).toContain("is-active");
    fireEvent.keyDown(tree, { key: "j" });
    expect(
      filterLink(container, "/vault?f=login", "logins").className,
    ).toContain("is-active");
    fireEvent.keyDown(tree, { key: "ArrowUp" });
    expect(
      filterLink(container, "/vault?f=favorites", "favorites").className,
    ).toContain("is-active");
  });
  it("walks off the open vault directory onto the next section", () => {
    const { container } = renderShell("/vault?f=trash");
    const tree = screen.getByRole("tree", { name: "Sections" });
    tree.focus();
    fireEvent.keyDown(tree, { key: "ArrowDown" });
    expect(tree.querySelector('a[href="/connections"]')?.className).toContain(
      "is-active",
    );
    expect(
      container.querySelector('a[href="/vault"] + .railtree__kids'),
    ).toBeTruthy();
    expect(document.getElementById("connections-tree")).toBeNull();
    fireEvent.keyDown(tree, { key: "5" });
    fireEvent.keyDown(tree, { key: "j" });
    const settings = screen.getByRole("treeitem", { name: "Settings" });
    expect(settings.getAttribute("aria-selected")).toBe("true");
    expect(settings.getAttribute("aria-expanded")).toBe("false");
    fireEvent.keyDown(tree, { key: "ArrowDown" });
    expect(settings.getAttribute("aria-selected")).toBe("true");
  });
  it("arrows move the rail when the vault tree is not focused", () => {
    const { container } = renderShell("/vault");
    fireEvent.keyDown(window, { key: "ArrowDown", bubbles: true });
    expect(
      filterLink(container, "/vault?f=favorites", "favorites").className,
    ).toContain("is-active");
  });
  it("repeats a rail motion by a vim count", () => {
    const { container } = renderShell("/vault");
    fireEvent.click(screen.getByRole("treeitem", { name: "logins" }));
    const tree = screen.getByRole("tree", { name: "Sections" });
    tree.focus();
    fireEvent.keyDown(tree, { key: "1" });
    fireEvent.keyDown(tree, { key: "j" });
    expect(
      filterLink(container, "/vault?f=login&folder=f1", "Work").className,
    ).toContain("is-active");
    fireEvent.keyDown(tree, { key: "1" });
    fireEvent.keyDown(tree, { key: "j" });
    expect(
      filterLink(container, "/vault?f=passkey", "passkeys").className,
    ).toContain("is-active");
    fireEvent.keyDown(tree, { key: "0" });
    expect(screen.getByRole("treeitem", { name: "Vault" }).className).toContain(
      "is-active",
    );
  });
});
