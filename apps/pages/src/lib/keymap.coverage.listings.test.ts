/** @vitest-environment jsdom */
/**
 * The second half of the keymap coverage suite: what the handler does with
 * no listing registered or a partial one, and which events it consumes.
 * Split from `keymap.coverage.test.ts` for the module-size budget (ADR 0093);
 * both halves drive the same harness.
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  createKeymapHandler,
  focusVaultListing,
  keymapSeams,
  registerRailKeymap,
  registerVaultKeymap,
} from "./keymap.js";
import {
  press,
  rail,
  registerShellJumps,
  resetKeymapDom,
  rowIn,
  targeted,
  vault,
} from "./keymap.test-harness.js";

let revokeShell = () => {};
beforeAll(() => {
  revokeShell = registerShellJumps();
});
afterAll(() => revokeShell());
afterEach(resetKeymapDom);

describe("unbound and partial listings", () => {
  it("does not throw on motions, verbs, counts or g when nothing is registered", () => {
    const showHelp = vi.fn();
    const navigate = vi.fn();
    const handler = createKeymapHandler({ navigate, showHelp });
    expect(() => {
      for (const key of [
        "j",
        "k",
        "l",
        "h",
        "G",
        "$",
        "Home",
        "End",
        "H",
        "M",
        "L",
        "PageDown",
        "PageUp",
        "Enter",
        "/",
        "Escape",
        "y",
        "u",
        "e",
        "x",
        "n",
        ".",
        "s",
        "?",
        "ArrowDown",
        "ArrowUp",
        "ArrowRight",
        "ArrowLeft",
        "Backspace",
      ]) {
        press(handler, key);
      }
      press(handler, "d", { ctrlKey: true });
      press(handler, "u", { ctrlKey: true });
      press(handler, "f", { ctrlKey: true });
      press(handler, "b", { ctrlKey: true });
      press(handler, "n", { ctrlKey: true });
      press(handler, "p", { ctrlKey: true });
      press(handler, "5");
      press(handler, "G");
      press(handler, "g");
      press(handler, "g");
      press(handler, "0");
      press(handler, "g");
      press(handler, "a");
      press(handler, "$", { shiftKey: false });
    }).not.toThrow();
    expect(showHelp).toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith("/access");
  });

  it("does not throw paging, edges, focus or 5gg on a listing that omits them", () => {
    const {
      page: _page,
      edge: _edge,
      focus: _focus,
      toIndex: _toIndex,
      ...rest
    } = vault();
    const release = registerVaultKeymap(rest);
    const handler = createKeymapHandler({
      navigate: vi.fn(),
      showHelp: vi.fn(),
    });
    expect(() => {
      press(handler, "H");
      press(handler, "M");
      press(handler, "L");
      press(handler, "PageDown");
      press(handler, "PageUp");
      press(handler, "d", { ctrlKey: true });
      press(handler, "u", { ctrlKey: true });
      press(handler, "f", { ctrlKey: true });
      press(handler, "b", { ctrlKey: true });
      press(handler, "Escape");
      press(handler, "5");
      press(handler, "g");
      press(handler, "g");
      press(handler, "5");
      press(handler, "G");
      focusVaultListing();
    }).not.toThrow();
    expect(rest.first).toHaveBeenCalledTimes(2);
    expect(rest.next).toHaveBeenCalledWith(4);
    release();
  });

  it("j on a non-listing node still drives the rail when only the rail is bound", () => {
    const nav = rail();
    const release = registerRailKeymap(nav);
    const handler = createKeymapHandler({
      navigate: vi.fn(),
      showHelp: vi.fn(),
    });
    targeted(handler, "j", document.body);
    expect(nav.next).toHaveBeenCalledWith(1);
    release();
  });

  it("j outside both listings drives the vault when both are bound", () => {
    const items = vault();
    const nav = rail();
    const stopVault = registerVaultKeymap(items);
    const stopRail = registerRailKeymap(nav);
    const handler = createKeymapHandler({
      navigate: vi.fn(),
      showHelp: vi.fn(),
    });
    targeted(handler, "j", document.body);
    expect(items.next).toHaveBeenCalledWith(1);
    expect(nav.next).not.toHaveBeenCalled();
    stopVault();
    stopRail();
  });

  it("Tab on a rail row with nothing registered is a no-op", () => {
    const handler = createKeymapHandler({
      navigate: vi.fn(),
      showHelp: vi.fn(),
    });
    expect(() => targeted(handler, "Tab", rowIn("railtree"))).not.toThrow();
  });

  it("Tab on a rail that has no focus method does not throw", () => {
    const { focus: _focus, ...rest } = rail();
    const release = registerRailKeymap(rest);
    const handler = createKeymapHandler({
      navigate: vi.fn(),
      showHelp: vi.fn(),
    });
    expect(() => targeted(handler, "Tab", rowIn("railtree"))).not.toThrow();
    release();
  });

  it("j on a vault row is a no-op when only the rail is bound", () => {
    const nav = rail();
    const release = registerRailKeymap(nav);
    const handler = createKeymapHandler({
      navigate: vi.fn(),
      showHelp: vi.fn(),
    });
    targeted(handler, "j", rowIn("vtree__rows"));
    expect(nav.next).not.toHaveBeenCalled();
    release();
  });
});

describe("preventDefault and chord timers", () => {
  it("prevents default on counts, g, motions and verbs", () => {
    const tree = vault();
    const release = registerVaultKeymap(tree);
    const showHelp = vi.fn();
    const navigate = vi.fn();
    const handler = createKeymapHandler({ navigate, showHelp });
    const keys: Array<[string, KeyboardEventInit?]> = [
      ["5"],
      ["j"],
      ["y"],
      ["?"],
      ["g"],
      ["g"],
      ["g"],
      ["a"],
      ["0"],
      ["1"],
      ["0"],
      ["k"],
      ["Escape"],
    ];
    for (const [key, init] of keys) {
      expect(press(handler, key, init).defaultPrevented).toBe(true);
    }
    expect(showHelp).toHaveBeenCalledOnce();
    expect(navigate).toHaveBeenCalledWith("/access");
    release();
  });

  it("Shift+? and unshifted ? both open help, and unshifted $ still jumps last", () => {
    const tree = vault();
    const release = registerVaultKeymap(tree);
    const showHelp = vi.fn();
    const handler = createKeymapHandler({
      navigate: vi.fn(),
      showHelp,
    });
    press(handler, "?", { shiftKey: true });
    press(handler, "?", { shiftKey: false });
    press(handler, "$", { shiftKey: false });
    expect(showHelp).toHaveBeenCalledTimes(2);
    expect(tree.last).toHaveBeenCalledOnce();
    release();
  });

  it("0 as first cancels a pending g so the next letter is not a section jump", () => {
    const tree = vault();
    const release = registerVaultKeymap(tree);
    const navigate = vi.fn();
    const handler = createKeymapHandler({ navigate, showHelp: vi.fn() });
    press(handler, "g");
    press(handler, "0");
    press(handler, "v");
    expect(tree.first).toHaveBeenCalledOnce();
    expect(navigate).not.toHaveBeenCalled();
    release();
  });

  it("a failed g chord is over before the next g, so gg is two keys later", () => {
    const tree = vault();
    const release = registerVaultKeymap(tree);
    const handler = createKeymapHandler({
      navigate: vi.fn(),
      showHelp: vi.fn(),
    });
    press(handler, "g");
    press(handler, "j");
    press(handler, "g");
    expect(tree.first).not.toHaveBeenCalled();
    expect(tree.next).toHaveBeenCalledWith(1);
    press(handler, "g");
    expect(tree.first).toHaveBeenCalledOnce();
    release();
  });

  it("a failed g chord cancels its timer so a later gg still jumps", () => {
    vi.useFakeTimers();
    const tree = vault();
    const release = registerVaultKeymap(tree);
    const handler = createKeymapHandler({
      navigate: vi.fn(),
      showHelp: vi.fn(),
    });
    press(handler, "g");
    press(handler, "j");
    vi.advanceTimersByTime(100);
    press(handler, "g");
    vi.advanceTimersByTime(keymapSeams.goTimeoutMs - 100);
    press(handler, "g");
    expect(tree.first).toHaveBeenCalledOnce();
    expect(tree.next).toHaveBeenCalledWith(1);
    release();
  });

  it("a repeating j still moves, but composing IME keydowns do not", () => {
    const tree = vault();
    const release = registerVaultKeymap(tree);
    const handler = createKeymapHandler({
      navigate: vi.fn(),
      showHelp: vi.fn(),
    });
    press(handler, "j", { repeat: true });
    expect(tree.next).toHaveBeenCalledWith(1);
    press(handler, "j", { isComposing: true });
    expect(tree.next).toHaveBeenCalledTimes(1);
    release();
  });
});
