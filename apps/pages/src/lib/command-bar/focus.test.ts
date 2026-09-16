/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  focusCommandBar,
  handleCommandBarChord,
  registerCommandBarMic,
  toggleCommandBarMic,
} from "./focus.js";

describe("command-bar focus chords", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("focusCommandBar selects the omnibox input", () => {
    document.body.innerHTML = '<input id="command-bar-input" value="hello" />';
    const input = document.getElementById("command-bar-input");
    expect(input).toBeInstanceOf(HTMLInputElement);
    focusCommandBar();
    expect(document.activeElement).toBe(input);
  });

  it("Ctrl/Cmd+L focuses the command bar like a browser URL bar", () => {
    document.body.innerHTML = '<input id="command-bar-input" />';
    const ctrl = new KeyboardEvent("keydown", {
      key: "l",
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    expect(handleCommandBarChord(ctrl)).toBe(true);
    expect(ctrl.defaultPrevented).toBe(true);
    expect(document.activeElement?.id).toBe("command-bar-input");

    const meta = new KeyboardEvent("keydown", {
      key: "l",
      metaKey: true,
      bubbles: true,
      cancelable: true,
    });
    expect(handleCommandBarChord(meta)).toBe(true);
  });

  it("registerCommandBarMic lets the keymap toggle listening", () => {
    const toggle = vi.fn();
    const stop = registerCommandBarMic(toggle);
    toggleCommandBarMic();
    expect(toggle).toHaveBeenCalledOnce();
    stop();
    toggleCommandBarMic();
    expect(toggle).toHaveBeenCalledOnce();
  });
});
