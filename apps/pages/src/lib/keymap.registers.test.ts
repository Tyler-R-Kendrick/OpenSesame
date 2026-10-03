/** @vitest-environment jsdom */
/**
 * ADR 0156: vim's registers in the shell. `q{a–z}` records what the keys ran
 * into macro `q-<letter>` until the next `q`; `@{a–z}` replays it, `@@` the
 * last one replayed, and a count in front repeats it. Authority is left out
 * of a recording, and nothing but a–z (or `@` after `@`) names a register.
 */
import {
  REGISTER_RECORD,
  REGISTER_REPLAY,
} from "@opensesame/app-core/lib/keymap/commands.js";
import {
  loadKeymap,
  resetKeymap,
  saveKeymap,
} from "@opensesame/app-core/lib/keymap/store.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { pendingSnapshot } from "./keymap-pending.js";
import {
  createChordState,
  createKeymapHandler,
  keymapSeams,
  registerVaultKeymap,
} from "./keymap.js";
import { press, vault } from "./keymap.test-harness.js";

function setup(chord = createChordState()) {
  const items = vault();
  const release = registerVaultKeymap(items);
  const handler = createKeymapHandler(
    { navigate: vi.fn(), showHelp: vi.fn() },
    chord,
  );
  const type = (...keys: string[]) => {
    for (const key of keys) press(handler, key);
  };
  return { items, release, handler, type };
}

afterEach(() => {
  resetKeymap();
  vi.useRealTimers();
  document.body.replaceChildren();
});

describe("recording a register", () => {
  it("keeps what the keys ran, with their counts, as q-<letter>", () => {
    const { items, release, type } = setup();
    type("q", "a");
    expect(pendingSnapshot()).toMatchObject({
      recording: "a",
      announcement: "recording @a",
    });
    type("3", "j", "j", "G", "g", "g");
    expect(items.next).toHaveBeenNthCalledWith(1, 3);
    type("q");
    expect(pendingSnapshot()).toMatchObject({
      recording: null,
      announcement: "recorded @a",
    });
    expect(loadKeymap().macros["q-a"]?.steps).toEqual([
      { command: "listing.next", count: 4 },
      { command: "listing.last", count: 1 },
      { command: "listing.first", count: 1 },
    ]);
    release();
  });

  it("runs trash and share but leaves them out of the recording", () => {
    const { items, release, type } = setup();
    type("q", "b", "x", "s", "k", "q");
    expect(items.trash).toHaveBeenCalledOnce();
    expect(items.share).toHaveBeenCalledOnce();
    expect(loadKeymap().macros["q-b"]?.steps).toEqual([
      { command: "listing.previous", count: 1 },
    ]);
    release();
  });

  it("keeps nothing for an empty recording, and replaces an older one", () => {
    const { release, type } = setup();
    type("q", "c", "q");
    expect(loadKeymap().macros["q-c"]).toBeUndefined();
    expect(pendingSnapshot().announcement).toBe("nothing recorded in @c");
    type("q", "c", "j", "q", "q", "c", "k", "q");
    expect(loadKeymap().macros["q-c"]?.steps).toEqual([
      { command: "listing.previous", count: 1 },
    ]);
    release();
  });

  it("announces the save's own error when storage refuses a recording with steps", () => {
    const { release, type } = setup();
    type("q", "e", "j", "k");
    const set = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => {
        throw new Error("quota");
      });
    type("q");
    set.mockRestore();
    expect(pendingSnapshot().announcement).toBe(
      "@e not kept: The keymap could not be saved on this device.",
    );
    expect(loadKeymap().macros["q-e"]).toBeUndefined();
    release();
  });

  it("keeps a refused recording, so a second q retries once there is room", () => {
    const { release, type } = setup();
    type("q", "e", "j", "k");
    const set = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => {
        throw new Error("quota");
      });
    type("q");
    expect(pendingSnapshot().announcement).toMatch(/^@e not kept: /);
    // Still recording: the same refusal again, not a new recording or nothing.
    type("q");
    expect(pendingSnapshot().announcement).toMatch(/^@e not kept: /);
    set.mockRestore();
    type("q");
    expect(pendingSnapshot().announcement).toBe("recorded @e");
    expect(loadKeymap().macros["q-e"]?.steps).toEqual([
      { command: "listing.next", count: 1 },
      { command: "listing.previous", count: 1 },
    ]);
    // Done: the next `q` starts a recording rather than stopping one.
    type("q", "f");
    expect(pendingSnapshot().announcement).toBe("recording @f");
    release();
  });

  it("writes a bound macro's steps in, since a macro cannot name another", () => {
    const saved = saveKeymap({
      bindings: { "Space h": "macro.hop" },
      macros: { hop: { steps: [{ command: "listing.last", count: 1 }] } },
      singleKeys: true,
    });
    expect(saved.ok).toBe(true);
    const { release, type } = setup();
    type("q", "d", "2", " ", "h", "q");
    expect(loadKeymap().macros["q-d"]?.steps).toEqual([
      { command: "listing.last", count: 1 },
      { command: "listing.last", count: 1 },
    ]);
    release();
  });

  it("cancels quietly on anything but a letter, and Escape keeps its meaning", () => {
    const { items, release, type, handler } = setup();
    type("q", "1");
    expect(pendingSnapshot().recording).toBeNull();
    type("j");
    expect(items.next).toHaveBeenCalledWith(1);
    type("q");
    expect(pendingSnapshot().awaiting).toBe("record");
    const leave = press(handler, "Escape");
    expect(leave.defaultPrevented).toBe(true);
    expect(items.closeSearch).toHaveBeenCalled();
    expect(pendingSnapshot().awaiting).toBeNull();
    type("@", "Z");
    expect(pendingSnapshot().awaiting).toBeNull();
    release();
  });

  it.each([
    ["Tab", {}],
    ["Tab", { shiftKey: true }],
    ["Enter", { shiftKey: true }],
    ["F10", { shiftKey: true }],
    ["ContextMenu", {}],
  ])(
    "lets %s %o pass untouched while a register letter is awaited",
    (key, init) => {
      for (const first of ["q", "@"]) {
        const { release, type, handler } = setup();
        type(first);
        expect(pendingSnapshot().awaiting).not.toBeNull();
        const event = press(handler, key, init);
        // The fixed key still does its own work: nothing swallowed it.
        expect(event.defaultPrevented, `${first} ${key}`).toBe(false);
        expect(pendingSnapshot().awaiting).toBeNull();
        // Held down, it is still not swallowed as a repeat of a half-typed key.
        type(first);
        const held = press(handler, key, { ...init, repeat: true });
        expect(held.defaultPrevented, `${first} ${key} held`).toBe(false);
        release();
        resetKeymap();
      }
    },
  );

  it("forgets a register key left waiting past the timeout", () => {
    vi.useFakeTimers();
    const { release, type } = setup();
    type("q");
    expect(pendingSnapshot().keys).toEqual(["q"]);
    vi.advanceTimersByTime(keymapSeams.goTimeoutMs);
    expect(pendingSnapshot().awaiting).toBeNull();
    type("a");
    expect(pendingSnapshot().recording).toBeNull();
    release();
  });

  it("follows the register keys wherever a person moved them", () => {
    const saved = saveKeymap({
      bindings: { Q: REGISTER_RECORD, q: "nop", "Space @": REGISTER_REPLAY },
      macros: {},
      singleKeys: true,
    });
    expect(saved.ok).toBe(true);
    const { items, release, type } = setup();
    type("q", "e", "j");
    expect(pendingSnapshot().recording).toBeNull();
    type("Q", "e", "k", "Q");
    expect(loadKeymap().macros["q-e"]?.steps).toEqual([
      { command: "listing.previous", count: 1 },
    ]);
    vi.mocked(items.previous).mockClear();
    type(" ", "@", "e");
    expect(items.previous).toHaveBeenCalledOnce();
    release();
  });
});

describe("replaying a register", () => {
  function recorded(): void {
    const saved = saveKeymap({
      bindings: {},
      macros: {
        "q-a": {
          steps: [
            { command: "listing.next", count: 3 },
            { command: "item.favorite", count: 1 },
          ],
        },
      },
      singleKeys: true,
    });
    expect(saved.ok).toBe(true);
  }

  it("runs q-<letter>, repeats it for a count, and @@ runs it again", () => {
    recorded();
    const { items, release, type } = setup();
    type("@", "a");
    expect(items.next).toHaveBeenCalledWith(3);
    expect(items.favorite).toHaveBeenCalledOnce();
    type("2", "@", "a");
    expect(items.favorite).toHaveBeenCalledTimes(3);
    type("@", "@");
    expect(items.favorite).toHaveBeenCalledTimes(4);
    type("3", "@", "@");
    expect(items.favorite).toHaveBeenCalledTimes(7);
    release();
  });

  it("does nothing for an empty register or @@ before any replay", () => {
    recorded();
    const { items, release, type } = setup();
    type("@", "@", "@", "z");
    expect(items.next).not.toHaveBeenCalled();
    release();
  });

  it("shows the count and the register key while it waits", () => {
    recorded();
    const { release, type } = setup();
    type("4", "@");
    expect(pendingSnapshot()).toMatchObject({
      count: 4,
      keys: ["@"],
      awaiting: "replay",
    });
    type("a");
    expect(pendingSnapshot()).toMatchObject({ count: 0, keys: [] });
    release();
  });

  it("writes a replay into a recording in progress", () => {
    recorded();
    const { release, type } = setup();
    type("q", "b", "@", "a", "q");
    expect(loadKeymap().macros["q-b"]?.steps).toEqual([
      { command: "listing.next", count: 3 },
      { command: "item.favorite", count: 1 },
    ]);
    release();
  });

  it("keeps recording across a remount of the handler", () => {
    const chord = createChordState();
    const first = setup(chord);
    first.type("q", "f", "j");
    first.release();
    const second = setup(chord);
    second.type("k", "q");
    expect(loadKeymap().macros["q-f"]?.steps).toEqual([
      { command: "listing.next", count: 1 },
      { command: "listing.previous", count: 1 },
    ]);
    second.release();
  });
});

describe("registers and event triggers", () => {
  it("refuses a trigger that would record or replay a register", () => {
    const saved = saveKeymap({
      bindings: {},
      macros: {
        loop: {
          on: "unlock",
          steps: [{ command: REGISTER_REPLAY, count: 1 }],
        },
      },
      singleKeys: true,
    });
    expect(saved.ok).toBe(false);
    expect(loadKeymap().macros.loop).toBeUndefined();
  });
});
