/**
 * The doubles and key-press helpers the keymap coverage suite drives the
 * handler with.
 *
 * Split out of `keymap.coverage.test.ts` when that file crossed the
 * module-size budget (ADR 0093). A suite owns its own lifecycle hooks; this
 * owns only the listing doubles and how a keydown is synthesised. Test
 * support: never imported by the app.
 */

import { registerLegacyShellData } from "@opensesame/app-core/lib/contributions.test-support.js";
import { vi } from "vitest";
import type { ListingMotion, VaultKeymapTarget } from "./keymap.js";

/**
 * The `g` jumps past `v` and `s` are contributions, so a suite that
 * characterizes the shell a whole plan draws registers the full set once.
 * SURFACE-09's core-only behaviour is asserted in `keymap.test.ts`.
 */
export function registerShellJumps(): () => void {
  return registerLegacyShellData();
}

/** Between cases: no rows left in the document, no fake clock left running. */
export function resetKeymapDom(): void {
  document.body.replaceChildren();
  vi.useRealTimers();
}

export function vault(
  overrides: Partial<VaultKeymapTarget> = {},
): VaultKeymapTarget {
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
export function rail(): ListingMotion {
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
export function shifted(key: string): boolean {
  return key.length === 1 && key !== key.toLowerCase()
    ? true
    : key === "$" || key === "?";
}
export function press(
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

export function rowIn(className: string): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = className;
  const row = document.createElement("div");
  wrap.append(row);
  document.body.append(wrap);
  return row;
}

export function targeted(
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
