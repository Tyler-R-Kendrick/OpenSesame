import { EMPTY_KEYMAP } from "@opensesame/app-core/lib/keymap/config.js";
import { describe, expect, it } from "vitest";
import { GESTURE_HELP, gestureHelpRows } from "./gesture-help.js";

const view = (config = EMPTY_KEYMAP, motion = true) => ({ config, motion });

describe("the sheet a finger reads", () => {
  it("is the fixed gestures alone until the keymap is known", () => {
    expect(gestureHelpRows()).toBe(GESTURE_HELP);
  });

  it("lists every gesture in force with what it runs", () => {
    const rows = gestureHelpRows(view());
    expect(rows.slice(0, GESTURE_HELP.length)).toEqual(GESTURE_HELP);
    expect(rows).toContainEqual(["Two-finger swipe left", "Dive in"]);
    expect(rows).toContainEqual(["Two-finger swipe right", "Climb out"]);
    expect(rows).toContainEqual(["Two-finger tap", "Command bar"]);
    expect(rows).toContainEqual(["Shake the phone", "Keyboard help"]);
    // A count has no gesture: no "or row N" under a finger.
    expect(rows).toContainEqual(["Two-finger swipe up", "Last row"]);
    expect(rows).toContainEqual(["Two-finger swipe down", "First row"]);
  });

  it("follows a gesture a person moved, and drops one they struck", () => {
    const rows = gestureHelpRows(
      view({
        ...EMPTY_KEYMAP,
        gestures: {
          "two-finger-tap": "item.new",
          "two-finger-swipe-up": "nop",
        },
      }),
    );
    expect(rows).toContainEqual(["Two-finger tap", "New item"]);
    expect(rows.some(([gesture]) => gesture === "Two-finger swipe up")).toBe(
      false,
    );
  });

  it("offers no shake where the phone cannot make one, or it is switched off", () => {
    const noSensor = gestureHelpRows(view(EMPTY_KEYMAP, false));
    expect(noSensor.some(([gesture]) => gesture === "Shake the phone")).toBe(
      false,
    );
    const off = gestureHelpRows(view({ ...EMPTY_KEYMAP, motion: false }));
    expect(off.some(([gesture]) => gesture === "Shake the phone")).toBe(false);
  });
});
