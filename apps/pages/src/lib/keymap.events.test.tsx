/** @vitest-environment jsdom */
/**
 * ADR 0155: event triggers. A trigger moves the vault list and nothing else,
 * however a hand-written file pairs two of them; it fires when the section
 * segment changes and not for each item opened inside it; `unlock` survives
 * the shell's `navigate` changing identity and is retried while a field holds
 * the keyboard.
 */
import type {
  KeymapConfig,
  Macro,
} from "@opensesame/app-core/lib/keymap/config.js";
import {
  resetKeymap,
  saveKeymap,
} from "@opensesame/app-core/lib/keymap/store.js";
import { act, cleanup, render } from "@testing-library/react";
import { MemoryRouter, type NavigateFunction, useNavigate } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  TRIGGER_LIMITS,
  UNLOCK_RETRY,
  type UnlockFeed,
  fireKeymapEvent,
  resetKeymapEvents,
  useKeymapEvents,
} from "./keymap-events.js";
import { registerRailKeymap, registerVaultKeymap } from "./keymap.js";
import { rail, vault } from "./keymap.test-harness.js";

function land(command: string, on: Macro["on"]): Macro {
  return { on, steps: [{ command, count: 1 }] };
}

function keymap(partial: Partial<KeymapConfig>): void {
  const saved = saveKeymap({
    bindings: {},
    macros: {},
    singleKeys: true,
    ...partial,
  });
  expect(saved.ok).toBe(true);
}

/** A store with the lock feed the shell reads, which a test can drive. */
function fakeStore() {
  const locks = new Set<() => void>();
  const listeners = new Set<() => void>();
  let status: "unlocked" | "locked" = "unlocked";
  const emit = () => {
    for (const listener of [...listeners]) listener();
  };
  const store: UnlockFeed = {
    onLock: (handler) => {
      locks.add(handler);
      return () => locks.delete(handler);
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot: () => ({ status }),
  };
  return {
    store,
    lock: () => {
      status = "locked";
      for (const handler of [...locks]) handler();
      emit();
    },
    unlock: () => {
      status = "unlocked";
      emit();
    },
  };
}

let go: NavigateFunction = () => {};

function Probe({ store }: { store: UnlockFeed }) {
  const navigate = useNavigate();
  go = navigate;
  useKeymapEvents(store, navigate);
  return null;
}

function mount(store: UnlockFeed, at = "/vault") {
  return render(
    <MemoryRouter initialEntries={[at]}>
      <Probe store={store} />
    </MemoryRouter>,
  );
}

function tick(ms = 0) {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  resetKeymapEvents();
});

afterEach(() => {
  cleanup();
  resetKeymap();
  resetKeymapEvents();
  vi.useRealTimers();
  document.body.replaceChildren();
});

describe("a trigger's motions", () => {
  it("never touch the rail, so two triggers cannot hand the route back and forth", () => {
    keymap({
      macros: {
        out: land("listing.next", "enter:settings"),
        back: land("listing.previous", "enter:vault"),
      },
    });
    const motion = rail();
    const navigateFromRail = vi.fn();
    motion.next = vi.fn(() => navigateFromRail("/vault"));
    motion.previous = vi.fn(() => navigateFromRail("/settings"));
    const release = registerRailKeymap(motion);
    const { store } = fakeStore();
    mount(store, "/settings");
    for (let step = 0; step < 50; step++) tick(20);
    expect(motion.next).not.toHaveBeenCalled();
    expect(motion.previous).not.toHaveBeenCalled();
    expect(navigateFromRail).not.toHaveBeenCalled();
    release();
  });

  it("move the vault list, and leave the tree's level alone", () => {
    keymap({
      macros: {
        tree: {
          on: "enter:vault",
          steps: [
            { command: "listing.dive", count: 1 },
            { command: "listing.climb", count: 1 },
            { command: "listing.next", count: 1 },
          ],
        },
      },
    });
    const items = vault();
    const release = registerVaultKeymap(items);
    expect(fireKeymapEvent("enter:vault", vi.fn())).toBe(1);
    expect(items.next).toHaveBeenCalledWith(1);
    expect(items.enter).not.toHaveBeenCalled();
    expect(items.parent).not.toHaveBeenCalled();
    release();
  });
});

describe("how often a trigger may fire", () => {
  it("caps one event at a few a second, and lets it fire again a second later", () => {
    keymap({ macros: { land: land("listing.last", "enter:vault") } });
    const items = vault();
    const release = registerVaultKeymap(items);
    for (let attempt = 0; attempt < 100; attempt++) {
      fireKeymapEvent("enter:vault", vi.fn());
    }
    expect(items.last).toHaveBeenCalledTimes(TRIGGER_LIMITS.perEventPerSecond);
    vi.advanceTimersByTime(1_000);
    fireKeymapEvent("enter:vault", vi.fn());
    expect(items.last).toHaveBeenCalledTimes(
      TRIGGER_LIMITS.perEventPerSecond + 1,
    );
    release();
  });

  it("caps every event together at a number a minute", () => {
    const macros = Object.fromEntries(
      Array.from({ length: 10 }, (_, index) => [
        `m${index}`,
        land("listing.last", `enter:s${index}`),
      ]),
    );
    keymap({ macros });
    const items = vault();
    const release = registerVaultKeymap(items);
    for (let index = 0; index < 10; index++) {
      for (let attempt = 0; attempt < 3; attempt++) {
        fireKeymapEvent(`enter:s${index}`, vi.fn());
      }
    }
    expect(items.last).toHaveBeenCalledTimes(TRIGGER_LIMITS.perMinute);
    vi.advanceTimersByTime(60_000);
    fireKeymapEvent("enter:s9", vi.fn());
    expect(items.last).toHaveBeenCalledTimes(TRIGGER_LIMITS.perMinute + 1);
    release();
  });

  it("drops an event fired while a trigger is running", () => {
    keymap({ macros: { land: land("listing.last", "enter:vault") } });
    let nested = -1;
    const items = vault({
      last: vi.fn(() => {
        nested = fireKeymapEvent("enter:vault", vi.fn());
      }),
    });
    const release = registerVaultKeymap(items);
    expect(fireKeymapEvent("enter:vault", vi.fn())).toBe(1);
    expect(nested).toBe(0);
    expect(items.last).toHaveBeenCalledOnce();
    release();
  });
});

describe("enter:<section>", () => {
  it("fires when the section changes, not for each path inside it", () => {
    keymap({ macros: { land: land("listing.last", "enter:vault") } });
    const items = vault();
    const release = registerVaultKeymap(items);
    const { store } = fakeStore();
    mount(store);
    tick();
    expect(items.last).toHaveBeenCalledTimes(1);
    act(() => go("/vault/login/1"));
    tick();
    act(() => go("/vault/login/2"));
    tick();
    act(() => go("/vault/login/2/edit"));
    tick();
    expect(items.last).toHaveBeenCalledTimes(1);
    act(() => go("/settings"));
    tick();
    act(() => go("/vault"));
    tick();
    expect(items.last).toHaveBeenCalledTimes(2);
    release();
  });
});

describe("unlock", () => {
  it("survives navigate changing identity before the arrival has landed", () => {
    keymap({ macros: { open: land("listing.last", "unlock") } });
    const items = vault();
    const release = registerVaultKeymap(items);
    const { store } = fakeStore();
    mount(store);
    act(() => go("/vault/login/1"));
    tick();
    expect(items.last).toHaveBeenCalledTimes(1);
    act(() => go("/vault/login/2"));
    tick(UNLOCK_RETRY.everyMs);
    expect(items.last).toHaveBeenCalledTimes(1);
    release();
  });

  it("waits while a field holds the keyboard, then runs once", () => {
    keymap({ macros: { open: land("listing.last", "unlock") } });
    const items = vault();
    const release = registerVaultKeymap(items);
    const field = document.createElement("input");
    document.body.append(field);
    field.focus();
    const { store } = fakeStore();
    mount(store);
    tick();
    tick(UNLOCK_RETRY.everyMs * 3);
    expect(items.last).not.toHaveBeenCalled();
    field.remove();
    tick(UNLOCK_RETRY.everyMs);
    expect(items.last).toHaveBeenCalledTimes(1);
    tick(UNLOCK_RETRY.everyMs * 5);
    expect(items.last).toHaveBeenCalledTimes(1);
    release();
  });

  it("gives up after its tries, and leaves no timer behind", () => {
    keymap({ macros: { open: land("listing.last", "unlock") } });
    const items = vault();
    const release = registerVaultKeymap(items);
    const field = document.createElement("input");
    document.body.append(field);
    field.focus();
    const { store } = fakeStore();
    mount(store);
    tick(UNLOCK_RETRY.everyMs * (UNLOCK_RETRY.tries + 2));
    expect(items.last).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    release();
  });

  it("fires again after a lock and an unlock", () => {
    keymap({ macros: { open: land("listing.last", "unlock") } });
    const items = vault();
    const release = registerVaultKeymap(items);
    const feed = fakeStore();
    mount(feed.store);
    tick();
    expect(items.last).toHaveBeenCalledTimes(1);
    act(() => feed.lock());
    tick(1_000);
    expect(items.last).toHaveBeenCalledTimes(1);
    act(() => feed.unlock());
    tick();
    expect(items.last).toHaveBeenCalledTimes(2);
    release();
  });
});
