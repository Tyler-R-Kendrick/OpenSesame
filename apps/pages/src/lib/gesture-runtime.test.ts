import { EMPTY_KEYMAP } from "@opensesame/app-core/lib/keymap/config.js";
/** @vitest-environment jsdom */
/**
 * ADR 0164: two fingers in a listing run the keymap's own commands. These
 * drive the touch handlers with real touch sequences, not with a handler spy.
 */
import {
  resetKeymap,
  saveKeymap,
} from "@opensesame/app-core/lib/keymap/store.js";
import { overlapCast } from "@opensesame/os-domain";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type GestureHost,
  createGestureHandlers,
  runGesture,
} from "./gesture-runtime.js";
import { createChordState } from "./keymap-chord.js";
import { registerRailKeymap, registerVaultKeymap } from "./keymap-targets.js";
import { rail, rowIn, vault } from "./keymap.test-harness.js";

type Finger = { id: number; x: number; y: number; target: EventTarget };

function touchEvent(
  type: string,
  fingers: readonly Finger[],
  changed: readonly Finger[],
  cancelable = true,
): TouchEvent {
  const event = new Event(type, { bubbles: true, cancelable });
  const list = (items: readonly Finger[]) =>
    items.map((f) => ({
      identifier: f.id,
      clientX: f.x,
      clientY: f.y,
      target: f.target,
    }));
  Object.defineProperty(event, "touches", { value: list(fingers) });
  Object.defineProperty(event, "changedTouches", { value: list(changed) });
  // jsdom has no Touch constructor; the handlers read only `touches` and
  // `changedTouches`, which this defines.
  return overlapCast<Event, TouchEvent>(event);
}

let clock = 0;
const handlers = (host: Partial<GestureHost> = {}) =>
  createGestureHandlers({
    navigate: vi.fn(),
    showHelp: vi.fn(),
    now: () => clock,
    ...host,
  });

/** Both fingers land, travel by `by`, and lift; returns the move events. */
function twoFingers(
  h: ReturnType<typeof handlers>,
  target: EventTarget,
  by: readonly [number, number],
  { ms = 200, other = target }: { ms?: number; other?: EventTarget } = {},
) {
  const a: Finger = { id: 1, x: 100, y: 300, target };
  const b: Finger = { id: 2, x: 180, y: 300, target: other };
  clock = 0;
  h.start(touchEvent("touchstart", [a], [a]));
  clock = 20;
  h.start(touchEvent("touchstart", [a, b], [b]));
  const a2 = { ...a, x: a.x + by[0], y: a.y + by[1] };
  const b2 = { ...b, x: b.x + by[0], y: b.y + by[1] };
  clock = ms / 2;
  const move = touchEvent("touchmove", [a2, b2], [a2, b2]);
  h.move(move);
  clock = ms;
  h.end(touchEvent("touchend", [b2], [a2]));
  h.end(touchEvent("touchend", [], [b2]));
  return move;
}

beforeEach(() => {
  clock = 0;
});

afterEach(() => {
  resetKeymap();
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

function listings() {
  const items = vault();
  const tree = rail();
  const releases = [registerVaultKeymap(items), registerRailKeymap(tree)];
  return {
    items,
    tree,
    release: () => {
      for (const release of releases) release();
    },
  };
}

describe("two-finger swipes in a listing", () => {
  it("run the default for each direction on the listing they began in", () => {
    const { items, tree, release } = listings();
    const h = handlers();
    const row = rowIn("vtree__rows");
    twoFingers(h, row, [90, 0]);
    expect(items.parent).toHaveBeenCalledOnce();
    twoFingers(h, row, [-90, 0]);
    expect(items.enter).toHaveBeenCalledOnce();
    twoFingers(h, row, [0, -90]);
    expect(items.last).toHaveBeenCalledOnce();
    twoFingers(h, row, [0, 90]);
    expect(items.first).toHaveBeenCalledOnce();
    twoFingers(h, rowIn("railtree"), [0, -90]);
    expect(tree.last).toHaveBeenCalledOnce();
    release();
  });

  it("do nothing outside a listing, where a swipe is the page's", () => {
    const { items, release } = listings();
    const h = handlers();
    twoFingers(h, document.body, [90, 0]);
    twoFingers(h, rowIn("vtree__rows"), [90, 0], { other: document.body });
    expect(items.parent).not.toHaveBeenCalled();
    release();
  });

  it("run what a person bound, and nothing for a gesture they struck", () => {
    saveKeymap({
      ...EMPTY_KEYMAP,
      gestures: {
        "two-finger-swipe-up": "item.favorite",
        "two-finger-swipe-down": "nop",
      },
    });
    const { items, release } = listings();
    const h = handlers();
    const row = rowIn("vtree__rows");
    twoFingers(h, row, [0, -90]);
    twoFingers(h, row, [0, 90]);
    expect(items.favorite).toHaveBeenCalledOnce();
    expect(items.last).not.toHaveBeenCalled();
    expect(items.first).not.toHaveBeenCalled();
    release();
  });

  it("run a macro, with the keymap's own limits", () => {
    saveKeymap({
      ...EMPTY_KEYMAP,
      macros: { two: { steps: [{ command: "listing.next", count: 2 }] } },
      gestures: { "two-finger-swipe-up": "macro.two" },
    });
    const { items, release } = listings();
    twoFingers(handlers(), rowIn("vtree__rows"), [0, -90]);
    expect(items.next).toHaveBeenCalledWith(2);
    release();
  });

  it("claim a bound drag so it does not scroll, and leave an unbound one", () => {
    const { release } = listings();
    const row = rowIn("vtree__rows");
    const bound = twoFingers(handlers(), row, [0, -90]);
    expect(bound.defaultPrevented).toBe(true);
    saveKeymap({ ...EMPTY_KEYMAP, gestures: { "two-finger-swipe-up": "nop" } });
    const struck = twoFingers(handlers(), row, [0, -90]);
    expect(struck.defaultPrevented).toBe(false);
    release();
  });

  it("do not claim a drag the browser has already taken", () => {
    const { release } = listings();
    const h = handlers();
    const target = rowIn("vtree__rows");
    const a: Finger = { id: 1, x: 100, y: 300, target };
    const b: Finger = { id: 2, x: 180, y: 300, target };
    h.start(touchEvent("touchstart", [a], [a]));
    h.start(touchEvent("touchstart", [a, b], [b]));
    const a2 = { ...a, y: 200 };
    const b2 = { ...b, y: 200 };
    const move = touchEvent("touchmove", [a2, b2], [a2, b2], false);
    h.move(move);
    expect(move.defaultPrevented).toBe(false);
    release();
  });
});

describe("a two-finger tap", () => {
  it("asks for the command bar from anywhere", () => {
    const bar = document.createElement("input");
    bar.id = "command-bar-input";
    document.body.append(bar);
    twoFingers(handlers(), document.body, [2, 3], { ms: 120 });
    expect(document.activeElement).toBe(bar);
  });

  it("is a gesture of its own binding", () => {
    saveKeymap({ ...EMPTY_KEYMAP, gestures: { "two-finger-tap": "item.new" } });
    const { items, release } = listings();
    twoFingers(handlers(), document.body, [2, 3], { ms: 120 });
    expect(items.create).toHaveBeenCalledOnce();
    release();
  });
});

describe("where a gesture stands down", () => {
  it("while a field holds the keyboard", () => {
    const { items, release } = listings();
    const field = document.createElement("textarea");
    document.body.append(field);
    twoFingers(handlers(), field, [90, 0]);
    expect(items.parent).not.toHaveBeenCalled();
    release();
  });

  it("while a text field has the keyboard up, wherever the fingers land", () => {
    const { items, release } = listings();
    const field = document.createElement("input");
    document.body.append(field);
    field.focus();
    twoFingers(handlers(), rowIn("vtree__rows"), [90, 0]);
    expect(items.parent).not.toHaveBeenCalled();
    field.blur();
    // A focused choice or switch is not the keyboard: the gesture a person has
    // just bound can be tried at once.
    const choice = document.createElement("select");
    document.body.append(choice);
    choice.focus();
    twoFingers(handlers(), rowIn("vtree__rows"), [90, 0]);
    expect(items.parent).toHaveBeenCalledOnce();
    release();
  });

  it("while a dialog or a context menu holds the screen", () => {
    const { items, release } = listings();
    const row = rowIn("vtree__rows");
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    document.body.append(dialog);
    twoFingers(handlers(), row, [90, 0]);
    dialog.remove();
    const menu = document.createElement("div");
    menu.className = "ctxmenu";
    menu.setAttribute("role", "menu");
    document.body.append(menu);
    twoFingers(handlers(), row, [90, 0]);
    expect(items.parent).not.toHaveBeenCalled();
    release();
  });

  it("for the whole of a touch that began there, then listens again", () => {
    const { items, release } = listings();
    const h = handlers();
    const field = document.createElement("input");
    document.body.append(field);
    twoFingers(h, field, [90, 0]);
    twoFingers(h, rowIn("vtree__rows"), [90, 0]);
    expect(items.parent).toHaveBeenCalledOnce();
    release();
  });
});

describe("what is never a gesture", () => {
  it("one finger, a third finger, a late second finger, a pinch", () => {
    const { items, release } = listings();
    const h = handlers();
    const target = rowIn("vtree__rows");
    const a: Finger = { id: 1, x: 100, y: 300, target };
    h.start(touchEvent("touchstart", [a], [a]));
    const a2 = { ...a, x: 300 };
    h.move(touchEvent("touchmove", [a2], [a2]));
    h.end(touchEvent("touchend", [], [a2]));

    const b: Finger = { id: 2, x: 180, y: 300, target };
    const c: Finger = { id: 3, x: 260, y: 300, target };
    h.start(touchEvent("touchstart", [a], [a]));
    h.start(touchEvent("touchstart", [a, b], [b]));
    h.start(touchEvent("touchstart", [a, b, c], [c]));
    const moved = [a, b, c].map((f) => ({ ...f, x: f.x + 90 }));
    h.move(touchEvent("touchmove", moved, moved));
    h.end(touchEvent("touchend", [], moved));

    clock = 0;
    h.start(touchEvent("touchstart", [a], [a]));
    clock = 500;
    h.start(touchEvent("touchstart", [a, b], [b]));
    const late = [a, b].map((f) => ({ ...f, x: f.x + 90 }));
    h.move(touchEvent("touchmove", late, late));
    h.end(touchEvent("touchend", [], late));

    clock = 0;
    h.start(touchEvent("touchstart", [a], [a]));
    h.start(touchEvent("touchstart", [a, b], [b]));
    const apart = [
      { ...a, x: 60 },
      { ...b, x: 280 },
    ];
    h.move(touchEvent("touchmove", apart, apart));
    clock = 200;
    h.end(touchEvent("touchend", [], apart));

    expect(items.parent).not.toHaveBeenCalled();
    expect(items.enter).not.toHaveBeenCalled();
    release();
  });

  it("a cancelled touch", () => {
    const { items, release } = listings();
    const h = handlers();
    const target = rowIn("vtree__rows");
    const a: Finger = { id: 1, x: 100, y: 300, target };
    const b: Finger = { id: 2, x: 180, y: 300, target };
    h.start(touchEvent("touchstart", [a], [a]));
    h.start(touchEvent("touchstart", [a, b], [b]));
    h.cancel();
    const moved = [a, b].map((f) => ({ ...f, x: f.x + 90 }));
    h.end(touchEvent("touchend", [], moved));
    expect(items.parent).not.toHaveBeenCalled();
    release();
  });
});

describe("a gesture is a way to press a key, not a second authority", () => {
  it("goes into a register recording as the key would", () => {
    const chord = createChordState();
    chord.registers.recording = { register: "a", steps: [] };
    saveKeymap({
      ...EMPTY_KEYMAP,
      gestures: { "two-finger-swipe-up": "item.favorite" },
    });
    const { release } = listings();
    twoFingers(handlers({ chord }), rowIn("vtree__rows"), [0, -90]);
    expect(chord.registers.recording?.steps).toEqual([
      { command: "item.favorite", count: 1 },
    ]);
    release();
  });

  it("runs only through the keymap's rules: nothing is bound to a lock", () => {
    saveKeymap({ ...EMPTY_KEYMAP });
    expect(
      saveKeymap({ ...EMPTY_KEYMAP, gestures: { shake: "item.trash" } }).ok,
    ).toBe(false);
    const { items, release } = listings();
    expect(
      runGesture(
        "shake",
        { target: null },
        { navigate: vi.fn(), showHelp: vi.fn() },
      ),
    ).toBe(true);
    expect(items.trash).not.toHaveBeenCalled();
    release();
  });

  it("asks for help on a shake by default, and nothing once it is struck", () => {
    const showHelp = vi.fn();
    expect(
      runGesture("shake", { target: null }, { navigate: vi.fn(), showHelp }),
    ).toBe(true);
    expect(showHelp).toHaveBeenCalledOnce();
    saveKeymap({ ...EMPTY_KEYMAP, gestures: { shake: "nop" } });
    expect(
      runGesture("shake", { target: null }, { navigate: vi.fn(), showHelp }),
    ).toBe(false);
    expect(showHelp).toHaveBeenCalledOnce();
  });
});
