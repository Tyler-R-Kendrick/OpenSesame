/** @vitest-environment jsdom */
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ContextMenuLayer } from "../../components/context-menu/ContextMenuLayer.js";
import { closeContextMenu } from "../../components/context-menu/menu-model.js";
import { gestureLimits } from "../../lib/gestures.js";
import { VaultTree, vaultTreeSeams } from "./VaultTree.js";
import { makeLogin, makeNote } from "./section-items.test-support.js";
import type { VaultTreeActions } from "./vault-menu.js";

Object.assign(vaultTreeSeams, {
  activeTomb: () => "personal",
  loadCollapsed: async (): Promise<string[]> => [],
  saveCollapsed: async () => undefined,
});

function spies(): VaultTreeActions {
  return {
    open: vi.fn(),
    preview: vi.fn(),
    copySecret: vi.fn(),
    copyUsername: vi.fn(),
    edit: vi.fn(),
    trash: vi.fn(),
    favorite: vi.fn(),
    share: vi.fn(),
    create: vi.fn(),
    restore: vi.fn(),
    purge: vi.fn(),
  };
}

let actions = spies();
beforeEach(() => {
  actions = spies();
});
afterEach(() => {
  act(() => closeContextMenu());
  cleanup();
});

function draw(items = [makeLogin(), makeNote()]) {
  render(
    <MemoryRouter>
      <VaultTree
        items={items}
        folders={[]}
        title="All items"
        total={items.length}
        actions={actions}
        emptyMessage="Nothing here"
      />
      <ContextMenuLayer />
    </MemoryRouter>,
  );
}

describe("the vault listing's context menu", () => {
  it("gives an item the verbs its keys run, with the keys shown", () => {
    draw();
    fireEvent.contextMenu(screen.getByText("Webmail"));
    const menu = screen.getByRole("menu", { name: "Actions for Webmail" });
    const copy = within(menu).getByRole("menuitem", { name: "Copy username" });
    expect(copy.getAttribute("aria-keyshortcuts")).toBe("u");
    fireEvent.click(copy);
    expect(actions.copyUsername).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Webmail" }),
    );
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("disables what an item cannot answer instead of doing nothing", () => {
    draw();
    fireEvent.contextMenu(screen.getByText("Scratch pad"));
    const menu = screen.getByRole("menu");
    expect(
      within(menu)
        .getByRole("menuitem", { name: "Copy username" })
        .getAttribute("aria-disabled"),
    ).toBe("true");
  });

  it("offers a trashed item restore, and asks before deleting it for good", () => {
    draw([makeLogin({ deletedAt: "2026-08-03T00:00:00Z" })]);
    fireEvent.contextMenu(screen.getByText("Webmail"));
    const menu = screen.getByRole("menu");
    expect(within(menu).queryByRole("menuitem", { name: "Edit" })).toBeNull();
    fireEvent.click(
      within(menu).getByRole("menuitem", { name: "Delete permanently" }),
    );
    expect(actions.purge).not.toHaveBeenCalled();
    fireEvent.click(
      within(screen.getByRole("menu")).getByRole("menuitem", {
        name: "Really delete permanently? This cannot be undone",
      }),
    );
    expect(actions.purge).toHaveBeenCalledTimes(1);
  });

  it("opens the same menu for a finger held on a row", () => {
    vi.useFakeTimers();
    try {
      draw();
      const row = screen.getByText("Webmail");
      const down = new MouseEvent("pointerdown", { bubbles: true });
      Object.defineProperty(down, "pointerType", { value: "touch" });
      act(() => {
        row.dispatchEvent(down);
        vi.advanceTimersByTime(gestureLimits.longPressMs + 10);
      });
      expect(
        screen.getByRole("menu", { name: "Actions for Webmail" }),
      ).toBeTruthy();
      // The lift that ends the hold does not also open the item.
      fireEvent.click(row);
      expect(actions.open).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("shares one list with the row's ⋯ key", () => {
    draw();
    fireEvent.click(
      screen.getByRole("button", { name: "Actions for Webmail" }),
    );
    const menu = screen.getByRole("menu", { name: "Actions for Webmail" });
    expect(
      within(menu)
        .getAllByRole("menuitem")
        .map((item) => item.getAttribute("aria-label")),
    ).toEqual([
      "Open",
      "Edit",
      "Copy secret",
      "Copy username",
      "Favorite",
      "Trash",
    ]);
  });
});
