/** @vitest-environment jsdom */
/**
 * ADR 0156: the keymap lives in storage, so a second tab can change it. The
 * shell reads it again on `storage` and `focus`, only when it differs from the
 * live copy, and never empties a keymap it cannot read back.
 */
import {
  type KeymapConfig,
  keymapJson,
} from "@opensesame/app-core/lib/keymap/config.js";
import {
  KEYMAP_KEY,
  loadKeymap,
  refreshKeymap,
  resetKeymap,
  subscribeKeymap,
} from "@opensesame/app-core/lib/keymap/store.js";
import { maybeLocalStore } from "@opensesame/app-core/ports.js";
import { act, cleanup, render } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type UnlockFeed,
  resetKeymapEvents,
  useKeymapEvents,
} from "./keymap-events.js";

const written: KeymapConfig = {
  bindings: { x: "listing.previous" },
  macros: {},
  singleKeys: true,
};

const feed: UnlockFeed = {};

function Shell() {
  useKeymapEvents(feed, () => {});
  return null;
}

function mount() {
  return render(
    <MemoryRouter initialEntries={["/vault"]}>
      <Shell />
    </MemoryRouter>,
  );
}

/** What another tab does: it writes storage, and this tab is told, or not. */
function otherTabWrites(config: KeymapConfig): void {
  maybeLocalStore()?.setItem(KEYMAP_KEY, JSON.stringify(keymapJson(config)));
}

afterEach(() => {
  cleanup();
  resetKeymap();
  resetKeymapEvents();
  vi.restoreAllMocks();
});

describe("the keymap another tab wrote", () => {
  it("listens for storage and focus for as long as the shell is mounted", () => {
    const added = vi.spyOn(window, "addEventListener");
    const removed = vi.spyOn(window, "removeEventListener");
    const view = mount();
    const ours = (name: string) => name === "storage" || name === "focus";
    const addedOurs = added.mock.calls.filter(([name]) => ours(name));
    expect(addedOurs.map(([name]) => name).sort()).toEqual([
      "focus",
      "storage",
    ]);
    view.unmount();
    const removedOurs = removed.mock.calls.filter(([name]) => ours(name));
    expect(removedOurs.map(([name]) => name).sort()).toEqual([
      "focus",
      "storage",
    ]);
    for (const [name, handler] of addedOurs) {
      expect(removed).toHaveBeenCalledWith(name, handler);
    }
  });

  it("is read on focus when it differs, and never redraws when it does not", () => {
    mount();
    const heard = vi.fn();
    const stop = subscribeKeymap(heard);
    otherTabWrites(written);
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(loadKeymap().bindings).toEqual(written.bindings);
    expect(heard).toHaveBeenCalledTimes(1);
    act(() => {
      window.dispatchEvent(new Event("focus"));
      window.dispatchEvent(
        new StorageEvent("storage", {
          key: KEYMAP_KEY,
          newValue: JSON.stringify(keymapJson(written)),
        }),
      );
    });
    expect(heard).toHaveBeenCalledTimes(1);
    stop();
  });

  it("is reset when the other tab removed it", () => {
    mount();
    otherTabWrites(written);
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(loadKeymap().bindings).toEqual(written.bindings);
    maybeLocalStore()?.removeItem(KEYMAP_KEY);
    act(() => {
      window.dispatchEvent(
        new StorageEvent("storage", { key: KEYMAP_KEY, newValue: null }),
      );
    });
    expect(loadKeymap().bindings).toEqual({});
  });

  it("keeps the live keymap while storage cannot be read", () => {
    otherTabWrites(written);
    refreshKeymap();
    expect(loadKeymap().bindings).toEqual(written.bindings);
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(() => refreshKeymap()).not.toThrow();
    expect(loadKeymap().bindings).toEqual(written.bindings);
  });
});
