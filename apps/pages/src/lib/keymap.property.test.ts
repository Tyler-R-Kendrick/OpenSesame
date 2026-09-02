/** @vitest-environment jsdom */
import fc from "fast-check";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type VaultKeymapTarget,
  createKeymapHandler,
  registerVaultKeymap,
} from "./keymap.js";

/**
 * Property / fuzz: random key streams must not throw, and every next/previous
 * count that fires is a bounded positive integer.
 *
 * Pages uses fast-check for this (the tutorial adversarial suites already
 * do). Jazzer.js in `packages/fuzz` is for parsers and redaction, not a
 * DOM keymap.
 */

const KEYS = [
  "j",
  "k",
  "h",
  "l",
  "G",
  "g",
  "0",
  "1",
  "5",
  "9",
  "H",
  "M",
  "L",
  "Enter",
  "/",
  "Escape",
  "Tab",
  " ",
  "ArrowDown",
  "ArrowUp",
  "Home",
  "End",
  "PageDown",
  "Backspace",
  "$",
  "y",
  "n",
  "q",
  "a",
];

function target(): VaultKeymapTarget & { counts: number[] } {
  const counts: number[] = [];
  const record =
    (name: "next" | "previous") =>
    (n = 1) => {
      counts.push(n);
    };
  return {
    next: record("next"),
    previous: record("previous"),
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
    counts,
  };
}

afterEach(() => {
  document.body.replaceChildren();
});

describe("listing keymap properties", () => {
  it("any finite key stream stays inside the count cap and does not throw", () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom(...KEYS), { maxLength: 48 }),
        (keys) => {
          const tree = target();
          const release = registerVaultKeymap(tree);
          const handler = createKeymapHandler({
            navigate: () => undefined,
            showHelp: () => undefined,
          });
          expect(() => {
            for (const key of keys) {
              handler(new KeyboardEvent("keydown", { key, cancelable: true }));
            }
          }).not.toThrow();
          for (const n of tree.counts) {
            expect(n).toBeGreaterThanOrEqual(1);
            expect(n).toBeLessThanOrEqual(999);
          }
          release();
        },
      ),
      { numRuns: 40 },
    );
  });
});
