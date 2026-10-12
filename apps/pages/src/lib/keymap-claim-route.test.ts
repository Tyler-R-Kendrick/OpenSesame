/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createKeymapHandler } from "./keymap.js";
import { press, resetKeymapDom } from "./keymap.test-harness.js";

afterEach(() => {
  resetKeymapDom();
  history.replaceState(null, "", "/");
});

describe("claim route keymap", () => {
  it("on /claim Ctrl-l and Cmd-l stay with the browser address bar", () => {
    document.body.innerHTML = '<input id="command-bar-input" />';
    const field = document.createElement("input");
    document.body.append(field);
    const handler = createKeymapHandler({
      navigate: vi.fn(),
      showHelp: vi.fn(),
    });
    const pressL = (
      path: string,
      init: KeyboardEventInit,
      target: EventTarget,
    ) => {
      history.replaceState(null, "", path);
      const event = new KeyboardEvent("keydown", {
        key: "l",
        cancelable: true,
        ...init,
      });
      Object.defineProperty(event, "target", { value: target });
      handler(event);
      return event;
    };
    for (const init of [{ ctrlKey: true }, { metaKey: true }]) {
      const event = pressL("/claim", init, field);
      expect(event.defaultPrevented).toBe(false);
    }
    expect(document.activeElement?.id).not.toBe("command-bar-input");
    const bare = pressL("/claim", { ctrlKey: true }, document.body);
    expect(bare.defaultPrevented).toBe(false);
    const underBase = pressL("/OpenSesame/claim", { ctrlKey: true }, field);
    expect(underBase.defaultPrevented).toBe(false);
    history.replaceState(null, "", "/claim");
    const colon = press(handler, ":");
    expect(colon.defaultPrevented).toBe(true);
    expect(document.activeElement?.id).toBe("command-bar-input");
    const onVault = pressL("/vault", { ctrlKey: true }, field);
    expect(onVault.defaultPrevented).toBe(true);
    expect(document.activeElement?.id).toBe("command-bar-input");
  });
});
