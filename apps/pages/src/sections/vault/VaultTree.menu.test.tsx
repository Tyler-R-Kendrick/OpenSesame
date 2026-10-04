/** @vitest-environment jsdom */
import type { SecretItem, VaultItem } from "@opensesame/vault-core";
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
import { type VaultTreeActions, vaultRowMenu } from "./vault-menu.js";

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
    shareGrant: vi.fn(),
    create: vi.fn(),
    restore: vi.fn(),
    purge: vi.fn(),
  };
}

function makeSecret(overrides: Partial<SecretItem> = {}): SecretItem {
  return {
    id: "itm_secret",
    kind: "secret",
    name: "Deploy key",
    folderId: null,
    favorite: false,
    notes: "",
    fields: [],
    createdAt: "2026-08-01T00:00:00Z",
    updatedAt: "2026-08-01T00:00:00Z",
    deletedAt: null,
    value: "canary-secret-value",
    ceiling: [],
    grantees: [],
    connectionRef: "",
    ...overrides,
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

function draw(items: VaultItem[] = [makeLogin(), makeNote()]) {
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

/** A one-finger touch event, carrying only what the drag claim reads. */
function touch(type: string, x: number, y: number): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "touches", {
    value: type === "touchend" ? [] : [{ clientX: x, clientY: y }],
  });
  return event;
}

describe("the vault listing's context menu", () => {
  it("keeps the browser out of a row's sideways swipe, so no fling eats the first tap", () => {
    draw();
    const row = screen.getByText("Webmail");
    const tree = screen.getByRole("tree", { name: "Vault items" });
    row.dispatchEvent(touch("touchstart", 300, 100));
    const sideways = touch("touchmove", 240, 102);
    row.dispatchEvent(sideways);
    expect(sideways.defaultPrevented).toBe(true);
    row.dispatchEvent(touch("touchend", 0, 0));
    tree.dispatchEvent(touch("touchstart", 300, 100));
    const scroll = touch("touchmove", 298, 180);
    tree.dispatchEvent(scroll);
    expect(scroll.defaultPrevented).toBe(false);
  });

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

  it("does not offer a new item from the trash directory", () => {
    const trashed = { ...spies(), inTrash: true };
    const labels = (row: Parameters<typeof vaultRowMenu>[0]) =>
      vaultRowMenu(
        row,
        trashed,
        () => undefined,
        () => undefined,
      )
        .flat()
        .map((entry) => entry.label);
    expect(labels(null)).toEqual(["Search"]);
    expect(
      labels({
        type: "dir",
        key: "dir_fld",
        path: "Work/",
        name: "Work",
        count: 1,
        expanded: true,
      }),
    ).toEqual(["Collapse"]);
    actions = trashed;
    draw([makeLogin({ deletedAt: "2026-08-03T00:00:00Z" })]);
    fireEvent.contextMenu(screen.getByRole("tree"));
    const menu = screen.getByRole("menu", { name: "Vault items" });
    expect(within(menu).getByRole("menuitem", { name: "Search" })).toBeTruthy();
    expect(
      within(menu).queryByRole("menuitem", { name: "New item" }),
    ).toBeNull();
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

  it("offers a secret one clipboard action", () => {
    draw([makeSecret()]);
    fireEvent.contextMenu(screen.getByText("Deploy key"));
    const menu = screen.getByRole("menu", { name: "Actions for Deploy key" });
    expect(
      within(menu)
        .getAllByRole("menuitem")
        .map((item) => item.getAttribute("aria-label")),
    ).toEqual([
      "Open",
      "Edit",
      "Copy to Clipboard",
      "Favorite",
      "Share",
      "Trash",
    ]);
    const copy = within(menu).getByRole("menuitem", {
      name: "Copy to Clipboard",
    });
    expect(copy.getAttribute("aria-keyshortcuts")).toBe("y");
    fireEvent.click(copy);
    expect(actions.copySecret).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Deploy key" }),
    );
    expect(actions.copyUsername).not.toHaveBeenCalled();
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

  it("opens Share onto the ways out, and the drop keeps the s key", () => {
    draw([makeSecret({ name: "Deploy token" })]);
    fireEvent.contextMenu(screen.getByText("Deploy token"));
    const menu = screen.getByRole("menu", { name: "Actions for Deploy token" });
    const share = within(menu).getByRole("menuitem", { name: "Share" });
    expect(share.getAttribute("aria-haspopup")).toBe("menu");
    fireEvent.click(share);
    const ways = screen.getByRole("menu", { name: "Share" });
    const drop = within(ways).getByRole("menuitem", { name: "Temporary drop" });
    expect(drop.getAttribute("aria-keyshortcuts")).toBe("s");
    fireEvent.click(drop);
    expect(actions.share).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Deploy token" }),
    );
  });

  it("offers neither way out for a record that is not a secret", () => {
    draw([makeNote()]);
    fireEvent.contextMenu(screen.getByText("Scratch pad"));
    const menu = screen.getByRole("menu");
    expect(within(menu).queryByRole("menuitem", { name: /Share/ })).toBeNull();
  });

  it("says on the row that a secret somebody else can open is shared", () => {
    draw([makeSecret({ grantees: ["agt_release_bot"] })]);
    expect(screen.getByTitle("Shared with agt_release_bot")).toBeTruthy();

    cleanup();
    draw([makeSecret()]);
    expect(screen.queryByTitle(/^Shared with/)).toBeNull();
  });
});
