/** @vitest-environment jsdom */
/**
 * ADR 0155 guardrail: Tab, Shift+Tab, Enter, Escape and F6 keep the
 * keyboard-only road open. The model refuses them at read time; this proves
 * the handler holds even if the map it reads somehow carried them — its fixed
 * keys are read before the keymap is, so a stray binding can never win.
 */
import { resetKeymap } from "@opensesame/app-core/lib/keymap/store.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createKeymapHandler,
  currentBindings,
  keymapSeams,
  registerRailKeymap,
  registerVaultKeymap,
} from "./keymap.js";
import { press, rail, vault } from "./keymap.test-harness.js";

afterEach(() => {
  keymapSeams.bindings = null;
  resetKeymap();
  document.body.replaceChildren();
});

describe("a map that binds the fixed keys anyway", () => {
  it("still lets Escape, Tab, F6 and Enter do their own work", () => {
    const bound = new Map([
      ...currentBindings(null),
      ["Escape", "listing.next"],
      ["Tab", "listing.next"],
      ["Shift+Tab", "listing.next"],
      ["F6", "listing.next"],
      ["Enter", "listing.next"],
    ]);
    keymapSeams.bindings = () => bound;
    const items = vault();
    const motion = rail();
    const releases = [registerVaultKeymap(items), registerRailKeymap(motion)];
    const handler = createKeymapHandler({
      navigate: vi.fn(),
      showHelp: vi.fn(),
    });

    press(handler, "Escape");
    expect(items.closeSearch).toHaveBeenCalled();

    expect(press(handler, "Tab").defaultPrevented).toBe(false);
    expect(press(handler, "Tab", { shiftKey: true }).defaultPrevented).toBe(
      false,
    );

    press(handler, "F6");
    expect(motion.focus).toHaveBeenCalledOnce();

    press(handler, "Enter");
    expect(items.activate).toHaveBeenCalledOnce();

    expect(items.next).not.toHaveBeenCalled();
    // Sanity: the map really did carry them, and an ordinary key still works.
    expect(bound.get("Enter")).toBe("listing.next");
    press(handler, "j");
    expect(items.next).toHaveBeenCalledOnce();
    for (const release of releases) release();
  });
});
