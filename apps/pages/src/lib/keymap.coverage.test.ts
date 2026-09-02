/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type ListingMotion,
  type VaultKeymapTarget,
  createKeymapHandler,
  focusRailListing,
  focusVaultListing,
  keymapSeams,
  registerKeymapHelp,
  registerRailKeymap,
  registerVaultKeymap,
  showKeymapHelp,
} from "./keymap.js";

function vault(overrides: Partial<VaultKeymapTarget> = {}): VaultKeymapTarget {
  return {
    next: vi.fn(),
    previous: vi.fn(),
    first: vi.fn(),
    last: vi.fn(),
    enter: vi.fn(),
    parent: vi.fn(),
    activate: vi.fn(),
    page: vi.fn(),
    edge: vi.fn(),
    focus: vi.fn(),
    toIndex: vi.fn(),
    search: vi.fn(),
    closeSearch: vi.fn(),
    copySecret: vi.fn(),
    copyUsername: vi.fn(),
    edit: vi.fn(),
    trash: vi.fn(),
    create: vi.fn(),
    favorite: vi.fn(),
    share: vi.fn(),
    ...overrides,
  };
}

function rail(): ListingMotion {
  return {
    next: vi.fn(),
    previous: vi.fn(),
    first: vi.fn(),
    last: vi.fn(),
    enter: vi.fn(),
    parent: vi.fn(),
    activate: vi.fn(),
    page: vi.fn(),
    edge: vi.fn(),
    focus: vi.fn(),
    toIndex: vi.fn(),
  };
}

function shifted(key: string): boolean {
  return key.length === 1 && key !== key.toLowerCase()
    ? true
    : key === "$" || key === "?";
}

function press(
  handler: (event: KeyboardEvent) => void,
  key: string,
  init: KeyboardEventInit = {},
): KeyboardEvent {
  const event = new KeyboardEvent("keydown", {
    key,
    cancelable: true,
    shiftKey: init.shiftKey ?? shifted(key),
    ...init,
  });
  handler(event);
  return event;
}

afterEach(() => {
  document.body.replaceChildren();
  vi.useRealTimers();
});

describe("registration identity", () => {
  it("releasing an old vault target does not clear a newer one", () => {
    const first = vault();
    const second = vault();
    const releaseFirst = registerVaultKeymap(first);
    const releaseSecond = registerVaultKeymap(second);
    const handler = createKeymapHandler({
      navigate: vi.fn(),
      showHelp: vi.fn(),
    });
    releaseFirst();
    press(handler, "j");
    expect(first.next).not.toHaveBeenCalled();
    expect(second.next).toHaveBeenCalledWith(1);
    releaseSecond();
    press(handler, "j");
    expect(second.next).toHaveBeenCalledTimes(1);
  });

  it("releasing an old rail target does not clear a newer one", () => {
    const first = rail();
    const second = rail();
    const releaseFirst = registerRailKeymap(first);
    const releaseSecond = registerRailKeymap(second);
    const handler = createKeymapHandler({
      navigate: vi.fn(),
      showHelp: vi.fn(),
    });
    releaseFirst();
    press(handler, "j");
    expect(first.next).not.toHaveBeenCalled();
    expect(second.next).toHaveBeenCalledWith(1);
    releaseSecond();
    press(handler, "j");
    expect(second.next).toHaveBeenCalledTimes(1);
  });

  it("showKeymapHelp is a no-op until registered, then only the live show fires", () => {
    showKeymapHelp();
    const first = vi.fn();
    const second = vi.fn();
    const releaseFirst = registerKeymapHelp(first);
    const releaseSecond = registerKeymapHelp(second);
    releaseFirst();
    showKeymapHelp();
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledOnce();
    releaseSecond();
    showKeymapHelp();
    expect(second).toHaveBeenCalledOnce();
  });

  it("focus helpers no-op without a listing and call focus when one is bound", () => {
    focusRailListing();
    focusVaultListing();
    const items = vault();
    const nav = rail();
    const stopVault = registerVaultKeymap(items);
    const stopRail = registerRailKeymap(nav);
    focusRailListing();
    focusVaultListing();
    expect(nav.focus).toHaveBeenCalledOnce();
    expect(items.focus).toHaveBeenCalledOnce();
    stopVault();
    stopRail();
    focusRailListing();
    focusVaultListing();
    expect(nav.focus).toHaveBeenCalledOnce();
    expect(items.focus).toHaveBeenCalledOnce();
  });

  it("focus helpers skip a listing that has no focus method", () => {
    const items = vault();
    const { focus: _vaultFocus, ...vaultRest } = items;
    const nav = rail();
    const { focus: _railFocus, ...railRest } = nav;
    const stopVault = registerVaultKeymap(vaultRest as VaultKeymapTarget);
    const stopRail = registerRailKeymap(railRest);
    expect(() => {
      focusRailListing();
      focusVaultListing();
    }).not.toThrow();
    stopVault();
    stopRail();
  });
});

describe("ignore guards", () => {
  it("does not move while typing in input, textarea, select, or contenteditable", () => {
    const tree = vault();
    const release = registerVaultKeymap(tree);
    const handler = createKeymapHandler({
      navigate: vi.fn(),
      showHelp: vi.fn(),
    });
    const editable = document.createElement("div");
    Object.defineProperty(editable, "isContentEditable", { value: true });
    for (const el of [
      document.createElement("input"),
      document.createElement("textarea"),
      document.createElement("select"),
      editable,
    ]) {
      const event = new KeyboardEvent("keydown", {
        key: "j",
        cancelable: true,
      });
      Object.defineProperty(event, "target", { value: el });
      handler(event);
    }
    expect(tree.next).not.toHaveBeenCalled();
    release();
  });

  it("ignores meta and alt but still runs Control paging", () => {
    const tree = vault();
    const release = registerVaultKeymap(tree);
    const handler = createKeymapHandler({
      navigate: vi.fn(),
      showHelp: vi.fn(),
    });
    press(handler, "j", { metaKey: true });
    press(handler, "j", { altKey: true });
    press(handler, "d", { ctrlKey: true });
    expect(tree.next).not.toHaveBeenCalled();
    expect(tree.page).toHaveBeenCalledWith(1, "half");
    release();
  });

  it("a dialog without aria-modal does not trap the keymap", () => {
    const tree = vault();
    const release = registerVaultKeymap(tree);
    const handler = createKeymapHandler({
      navigate: vi.fn(),
      showHelp: vi.fn(),
    });
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    document.body.append(dialog);
    press(handler, "j");
    expect(tree.next).toHaveBeenCalledWith(1);
    release();
  });
});

describe("counts and the g leader", () => {
  it("caps at 999 and treats 990j as nine hundred ninety", () => {
    const tree = vault();
    const release = registerVaultKeymap(tree);
    const handler = createKeymapHandler({
      navigate: vi.fn(),
      showHelp: vi.fn(),
    });
    for (const digit of "9991") press(handler, digit);
    press(handler, "j");
    expect(tree.next).toHaveBeenCalledWith(999);
    press(handler, "9");
    press(handler, "9");
    press(handler, "0");
    press(handler, "k");
    expect(tree.previous).toHaveBeenCalledWith(990);
    release();
  });

  it("Control+1 is not a count", () => {
    const tree = vault();
    const release = registerVaultKeymap(tree);
    const handler = createKeymapHandler({
      navigate: vi.fn(),
      showHelp: vi.fn(),
    });
    press(handler, "1", { ctrlKey: true });
    press(handler, "j");
    expect(tree.next).toHaveBeenCalledWith(1);
    release();
  });

  it("g then 599ms then g is still gg; at 600ms the chord has died", () => {
    vi.useFakeTimers();
    const tree = vault();
    const release = registerVaultKeymap(tree);
    const handler = createKeymapHandler({
      navigate: vi.fn(),
      showHelp: vi.fn(),
    });
    press(handler, "g");
    vi.advanceTimersByTime(keymapSeams.goTimeoutMs - 1);
    press(handler, "g");
    expect(tree.first).toHaveBeenCalledOnce();
    press(handler, "g");
    vi.advanceTimersByTime(keymapSeams.goTimeoutMs);
    press(handler, "g");
    expect(tree.first).toHaveBeenCalledOnce();
    release();
  });

  it("g V jumps to vault because the section letter is case-insensitive", () => {
    const tree = vault();
    const release = registerVaultKeymap(tree);
    const navigate = vi.fn();
    const handler = createKeymapHandler({ navigate, showHelp: vi.fn() });
    press(handler, "g");
    press(handler, "V");
    expect(navigate).toHaveBeenCalledWith("/vault");
    release();
  });

  it("g jumps every section letter", () => {
    const tree = vault();
    const release = registerVaultKeymap(tree);
    const navigate = vi.fn();
    const handler = createKeymapHandler({ navigate, showHelp: vi.fn() });
    for (const [letter, path] of [
      ["c", "/connections"],
      ["i", "/identity"],
      ["s", "/settings"],
      ["v", "/vault"],
    ] as const) {
      press(handler, "g");
      press(handler, letter);
      expect(navigate).toHaveBeenCalledWith(path);
    }
    release();
  });

  it("5gg uses toIndex when present and first+next when not", () => {
    const withIndex = vault();
    const releaseIndexed = registerVaultKeymap(withIndex);
    const handler = createKeymapHandler({
      navigate: vi.fn(),
      showHelp: vi.fn(),
    });
    press(handler, "5");
    press(handler, "g");
    press(handler, "g");
    expect(withIndex.toIndex).toHaveBeenCalledWith(4);
    expect(withIndex.first).not.toHaveBeenCalled();
    releaseIndexed();

    const { toIndex: _omit, ...rest } = vault();
    const plain = rest as VaultKeymapTarget;
    const releasePlain = registerVaultKeymap(plain);
    const handlerPlain = createKeymapHandler({
      navigate: vi.fn(),
      showHelp: vi.fn(),
    });
    press(handlerPlain, "5");
    press(handlerPlain, "g");
    press(handlerPlain, "g");
    expect(plain.first).toHaveBeenCalledOnce();
    expect(plain.next).toHaveBeenCalledWith(4);
    press(handlerPlain, "1");
    press(handlerPlain, "g");
    press(handlerPlain, "g");
    expect(plain.first).toHaveBeenCalledTimes(2);
    expect(plain.next).toHaveBeenCalledTimes(1);
    releasePlain();
  });
});

describe("bindings", () => {
  it("arrow aliases, Home/End, Backspace and Enter reach the listing", () => {
    const tree = vault();
    const release = registerVaultKeymap(tree);
    const handler = createKeymapHandler({
      navigate: vi.fn(),
      showHelp: vi.fn(),
    });
    press(handler, "ArrowDown");
    press(handler, "ArrowUp");
    press(handler, "ArrowRight");
    press(handler, "ArrowLeft");
    press(handler, "Backspace");
    press(handler, "Home");
    press(handler, "End");
    press(handler, "Enter");
    expect(tree.next).toHaveBeenCalledWith(1);
    expect(tree.previous).toHaveBeenCalledWith(1);
    expect(tree.enter).toHaveBeenCalledOnce();
    expect(tree.parent).toHaveBeenCalledTimes(2);
    expect(tree.first).toHaveBeenCalledOnce();
    expect(tree.last).toHaveBeenCalledOnce();
    expect(tree.activate).toHaveBeenCalledOnce();
    release();
  });

  it("a count repeats enter, parent and full-page", () => {
    const tree = vault();
    const release = registerVaultKeymap(tree);
    const handler = createKeymapHandler({
      navigate: vi.fn(),
      showHelp: vi.fn(),
    });
    press(handler, "3");
    press(handler, "l");
    press(handler, "2");
    press(handler, "h");
    press(handler, "2");
    press(handler, "PageDown");
    press(handler, "PageUp");
    expect(tree.enter).toHaveBeenCalledTimes(3);
    expect(tree.parent).toHaveBeenCalledTimes(2);
    expect(tree.page).toHaveBeenNthCalledWith(1, 1, "full");
    expect(tree.page).toHaveBeenNthCalledWith(2, 1, "full");
    expect(tree.page).toHaveBeenNthCalledWith(3, -1, "full");
    release();
  });

  it("Control n/p move and n/p without Control create/previous-verb", () => {
    const tree = vault();
    const release = registerVaultKeymap(tree);
    const handler = createKeymapHandler({
      navigate: vi.fn(),
      showHelp: vi.fn(),
    });
    press(handler, "n", { ctrlKey: true });
    press(handler, "p", { ctrlKey: true });
    press(handler, "n");
    press(handler, "u");
    press(handler, "e");
    press(handler, "x");
    press(handler, ".");
    press(handler, "/");
    press(handler, "y");
    press(handler, "$");
    press(handler, "?");
    expect(tree.next).toHaveBeenCalledWith(1);
    expect(tree.previous).toHaveBeenCalledWith(1);
    expect(tree.create).toHaveBeenCalledOnce();
    expect(tree.copyUsername).toHaveBeenCalledOnce();
    expect(tree.edit).toHaveBeenCalledOnce();
    expect(tree.trash).toHaveBeenCalledOnce();
    expect(tree.favorite).toHaveBeenCalledOnce();
    expect(tree.search).toHaveBeenCalledOnce();
    expect(tree.copySecret).toHaveBeenCalledOnce();
    expect(tree.last).toHaveBeenCalledOnce();
    release();
  });

  it("Control+u/f/b page and H/M/L hit the window edges", () => {
    const tree = vault();
    const release = registerVaultKeymap(tree);
    const handler = createKeymapHandler({
      navigate: vi.fn(),
      showHelp: vi.fn(),
    });
    press(handler, "u", { ctrlKey: true });
    press(handler, "f", { ctrlKey: true });
    press(handler, "b", { ctrlKey: true });
    press(handler, "H");
    press(handler, "M");
    press(handler, "L");
    expect(tree.page).toHaveBeenCalledWith(-1, "half");
    expect(tree.page).toHaveBeenCalledWith(1, "full");
    expect(tree.page).toHaveBeenCalledWith(-1, "full");
    expect(tree.edge).toHaveBeenCalledWith("high");
    expect(tree.edge).toHaveBeenCalledWith("mid");
    expect(tree.edge).toHaveBeenCalledWith("low");
    release();
  });

  it("Space preventDefault only when a listing holds the keyboard", () => {
    const tree = vault();
    const release = registerVaultKeymap(tree);
    const handler = createKeymapHandler({
      navigate: vi.fn(),
      showHelp: vi.fn(),
    });
    const loose = press(handler, " ");
    expect(loose.defaultPrevented).toBe(false);
    const wrap = document.createElement("nav");
    wrap.className = "railtree";
    const row = document.createElement("a");
    wrap.append(row);
    document.body.append(wrap);
    const held = new KeyboardEvent("keydown", {
      key: " ",
      bubbles: true,
      cancelable: true,
    });
    row.dispatchEvent(held);
    // The handler is not on the row — dispatch through the handler with target.
    const heldInTree = new KeyboardEvent("keydown", {
      key: " ",
      bubbles: true,
      cancelable: true,
    });
    Object.defineProperty(heldInTree, "target", { value: row });
    handler(heldInTree);
    expect(heldInTree.defaultPrevented).toBe(true);
    const stray = new KeyboardEvent("keydown", {
      key: "q",
      cancelable: true,
    });
    Object.defineProperty(stray, "target", { value: row });
    handler(stray);
    expect(stray.defaultPrevented).toBe(false);
    release();
  });
});

describe("listing focus", () => {
  it("Tab on the vault listing focuses the rail, and the reverse", () => {
    const items = vault();
    const nav = rail();
    const stopVault = registerVaultKeymap(items);
    const stopRail = registerRailKeymap(nav);
    const handler = createKeymapHandler({
      navigate: vi.fn(),
      showHelp: vi.fn(),
    });
    const railEl = document.createElement("nav");
    railEl.className = "railtree";
    const railRow = document.createElement("a");
    railEl.append(railRow);
    const vaultEl = document.createElement("div");
    vaultEl.className = "vtree__rows";
    const vaultRow = document.createElement("div");
    vaultEl.append(vaultRow);
    document.body.append(railEl, vaultEl);

    const fromRail = new KeyboardEvent("keydown", {
      key: "Tab",
      cancelable: true,
    });
    Object.defineProperty(fromRail, "target", { value: railRow });
    handler(fromRail);
    expect(items.focus).toHaveBeenCalledOnce();
    expect(nav.focus).not.toHaveBeenCalled();

    const fromVault = new KeyboardEvent("keydown", {
      key: "Tab",
      cancelable: true,
    });
    Object.defineProperty(fromVault, "target", { value: vaultRow });
    handler(fromVault);
    expect(nav.focus).toHaveBeenCalledOnce();
    stopVault();
    stopRail();
  });

  it("Tab on the rail with no vault listing focuses the rail itself", () => {
    const nav = rail();
    const stopRail = registerRailKeymap(nav);
    const handler = createKeymapHandler({
      navigate: vi.fn(),
      showHelp: vi.fn(),
    });
    const railEl = document.createElement("nav");
    railEl.className = "railtree";
    const railRow = document.createElement("a");
    railEl.append(railRow);
    document.body.append(railEl);
    const event = new KeyboardEvent("keydown", {
      key: "Tab",
      cancelable: true,
    });
    Object.defineProperty(event, "target", { value: railRow });
    handler(event);
    expect(nav.focus).toHaveBeenCalledOnce();
    expect(event.defaultPrevented).toBe(true);
    stopRail();
  });

  it("j on a vault row drives the vault even when a rail is bound", () => {
    const items = vault();
    const nav = rail();
    const stopVault = registerVaultKeymap(items);
    const stopRail = registerRailKeymap(nav);
    const handler = createKeymapHandler({
      navigate: vi.fn(),
      showHelp: vi.fn(),
    });
    const vaultEl = document.createElement("div");
    vaultEl.className = "vtree__rows";
    const vaultRow = document.createElement("div");
    vaultEl.append(vaultRow);
    document.body.append(vaultEl);
    const event = new KeyboardEvent("keydown", {
      key: "j",
      cancelable: true,
    });
    Object.defineProperty(event, "target", { value: vaultRow });
    handler(event);
    expect(items.next).toHaveBeenCalledWith(1);
    expect(nav.next).not.toHaveBeenCalled();
    stopVault();
    stopRail();
  });

  it("Escape closes search and focuses the listing that holds the keyboard", () => {
    const items = vault();
    const nav = rail();
    const stopVault = registerVaultKeymap(items);
    const stopRail = registerRailKeymap(nav);
    const handler = createKeymapHandler({
      navigate: vi.fn(),
      showHelp: vi.fn(),
    });
    const railEl = document.createElement("nav");
    railEl.className = "railtree";
    const railRow = document.createElement("a");
    railEl.append(railRow);
    document.body.append(railEl);
    const event = new KeyboardEvent("keydown", {
      key: "Escape",
      cancelable: true,
    });
    Object.defineProperty(event, "target", { value: railRow });
    handler(event);
    expect(items.closeSearch).toHaveBeenCalledOnce();
    expect(nav.focus).toHaveBeenCalledOnce();
    stopVault();
    stopRail();
  });

  it("Tab on the vault with no rail listing focuses the vault itself", () => {
    const items = vault();
    const stopVault = registerVaultKeymap(items);
    const handler = createKeymapHandler({
      navigate: vi.fn(),
      showHelp: vi.fn(),
    });
    const vaultEl = document.createElement("div");
    vaultEl.className = "vtree__rows";
    const vaultRow = document.createElement("div");
    vaultEl.append(vaultRow);
    document.body.append(vaultEl);
    const event = new KeyboardEvent("keydown", {
      key: "Tab",
      cancelable: true,
    });
    Object.defineProperty(event, "target", { value: vaultRow });
    handler(event);
    expect(items.focus).toHaveBeenCalledOnce();
    expect(event.defaultPrevented).toBe(true);
    stopVault();
  });

  it("Escape on a vault row with both listings focuses the vault", () => {
    const items = vault();
    const nav = rail();
    const stopVault = registerVaultKeymap(items);
    const stopRail = registerRailKeymap(nav);
    const handler = createKeymapHandler({
      navigate: vi.fn(),
      showHelp: vi.fn(),
    });
    const vaultEl = document.createElement("div");
    vaultEl.className = "vtree__rows";
    const vaultRow = document.createElement("div");
    vaultEl.append(vaultRow);
    document.body.append(vaultEl);
    const event = new KeyboardEvent("keydown", {
      key: "Escape",
      cancelable: true,
    });
    Object.defineProperty(event, "target", { value: vaultRow });
    handler(event);
    expect(items.closeSearch).toHaveBeenCalledOnce();
    expect(items.focus).toHaveBeenCalledOnce();
    expect(nav.focus).not.toHaveBeenCalled();
    stopVault();
    stopRail();
  });
});

function rowIn(className: string): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = className;
  const row = document.createElement("div");
  wrap.append(row);
  document.body.append(wrap);
  return row;
}

function targeted(
  handler: (event: KeyboardEvent) => void,
  key: string,
  target: EventTarget,
  init: KeyboardEventInit = {},
): KeyboardEvent {
  const event = new KeyboardEvent("keydown", {
    key,
    cancelable: true,
    shiftKey: init.shiftKey ?? shifted(key),
    ...init,
  });
  Object.defineProperty(event, "target", { value: target });
  handler(event);
  return event;
}

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
    const release = registerVaultKeymap(rest as VaultKeymapTarget);
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
