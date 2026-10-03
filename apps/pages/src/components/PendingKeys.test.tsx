/** @vitest-environment jsdom */
/**
 * ADR 0150: vim's `showcmd` and which-key in the statusline. The handler
 * publishes what is half-typed after every press; the segment draws the
 * count and keys, what each next key runs, and `recording @a`.
 */
import { keymapCommands } from "@opensesame/app-core/lib/keymap/commands.js";
import {
  resetKeymap,
  saveKeymap,
} from "@opensesame/app-core/lib/keymap/store.js";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  NO_PENDING,
  continuationsOf,
  hasPending,
  pendingSnapshot,
  publishPending,
  subscribePending,
} from "../lib/keymap-pending.js";
import {
  createKeymapHandler,
  currentBindings,
  keymapSeams,
  registerVaultKeymap,
} from "../lib/keymap.js";
import { press, rowIn, targeted, vault } from "../lib/keymap.test-harness.js";
import { PendingKeys } from "./PendingKeys.js";

function setup() {
  const release = registerVaultKeymap(vault());
  const handler = createKeymapHandler({
    navigate: vi.fn(),
    showHelp: vi.fn(),
  });
  return { release, handler };
}

afterEach(() => {
  cleanup();
  resetKeymap();
  publishPending(NO_PENDING);
  vi.useRealTimers();
  document.body.replaceChildren();
});

describe("the pending-keys store", () => {
  it("holds a count and a half-typed sequence, and clears once it runs", () => {
    const { release, handler } = setup();
    const heard = vi.fn();
    const stop = subscribePending(heard);
    press(handler, "3");
    expect(pendingSnapshot()).toMatchObject({ count: 3, keys: [] });
    press(handler, "g");
    expect(pendingSnapshot()).toMatchObject({ count: 3, keys: ["g"] });
    press(handler, "g");
    expect(hasPending(pendingSnapshot())).toBe(false);
    expect(heard).toHaveBeenCalledTimes(3);
    press(handler, "k");
    expect(heard).toHaveBeenCalledTimes(3);
    stop();
    release();
  });

  it("clears on the timeout, and when a field takes the keyboard", () => {
    vi.useFakeTimers();
    const { release, handler } = setup();
    press(handler, "g");
    expect(pendingSnapshot().keys).toEqual(["g"]);
    vi.advanceTimersByTime(keymapSeams.goTimeoutMs);
    expect(hasPending(pendingSnapshot())).toBe(false);

    press(handler, "5");
    const field = document.createElement("input");
    document.body.append(field);
    const typed = new KeyboardEvent("keydown", { key: "j", cancelable: true });
    Object.defineProperty(typed, "target", { value: field });
    handler(typed);
    expect(hasPending(pendingSnapshot())).toBe(false);
    release();
  });
});

describe("which-key", () => {
  it("lists every next key after a prefix with what it runs", () => {
    const next = continuationsOf(currentBindings(), ["g"], keymapCommands());
    expect(next).toEqual(
      expect.arrayContaining([
        { key: "g", label: "First row, or row N" },
        { key: "v", label: "Vault" },
        { key: "s", label: "Settings" },
      ]),
    );
    expect(continuationsOf(currentBindings(), [], keymapCommands())).toEqual(
      [],
    );
  });

  it("marks a key that only leads further, and names a macro by its @", () => {
    const saved = saveKeymap({
      bindings: { "Space f j": "listing.next", "Space t": "macro.triage" },
      macros: { triage: { steps: [{ command: "listing.search", count: 1 }] } },
      singleKeys: true,
    });
    expect(saved.ok).toBe(true);
    expect(
      continuationsOf(currentBindings(), ["Space"], keymapCommands()),
    ).toEqual([
      { key: "f", label: null },
      { key: "t", label: "@triage" },
    ]);
  });
});

describe("the statusline segment", () => {
  it("draws nothing while nothing is pending, but keeps its live region", () => {
    const { container } = render(<PendingKeys />);
    expect(container.querySelector(".pending-keys")).toBeNull();
    expect(container.querySelector('[aria-live="polite"]')).not.toBeNull();
  });

  it("draws the keys typed and the continuations of the prefix", () => {
    const { release, handler } = setup();
    const { container } = render(<PendingKeys />);
    act(() => {
      press(handler, "2");
      press(handler, "g");
    });
    const typed = container.querySelector(".pending-keys__typed");
    expect(typed?.textContent).toBe("2g");
    const which = screen.getByRole("list", { name: "Next keys" });
    expect(which.textContent).toContain("v Vault");
    expect(which.textContent).toContain("s Settings");
    act(() => {
      press(handler, "v");
    });
    expect(container.querySelector(".pending-keys")).toBeNull();
    release();
  });

  it("says recording @a in vim's words, and announces only start and stop", () => {
    const { release, handler } = setup();
    const { container } = render(<PendingKeys />);
    const live = container.querySelector('[aria-live="polite"]');
    act(() => {
      press(handler, "q");
    });
    expect(live?.textContent).toBe("");
    act(() => {
      press(handler, "a");
    });
    expect(container.querySelector(".pending-keys__rec")?.textContent).toBe(
      "recording @a",
    );
    expect(live?.textContent).toBe("recording @a");
    act(() => {
      press(handler, "j");
    });
    expect(live?.textContent).toBe("recording @a");
    act(() => {
      press(handler, "q");
    });
    expect(container.querySelector(".pending-keys__rec")).toBeNull();
    expect(live?.textContent).toBe("recorded @a");
    release();
  });

  it("offers the saved registers after @", () => {
    const saved = saveKeymap({
      bindings: {},
      macros: {
        "q-a": { steps: [{ command: "listing.next", count: 1 }] },
        "q-d": { steps: [{ command: "listing.last", count: 1 }] },
      },
      singleKeys: true,
    });
    expect(saved.ok).toBe(true);
    const { release, handler } = setup();
    render(<PendingKeys />);
    act(() => {
      press(handler, "@");
    });
    const which = screen.getByRole("list", { name: "Next keys" });
    expect(
      [...which.querySelectorAll("kbd")].map((key) => key.textContent),
    ).toEqual(["a", "d"]);
    release();
  });
});

describe("which-key in a listing's own keys", () => {
  const scoped = () => {
    const saved = saveKeymap({
      bindings: {},
      macros: {},
      singleKeys: true,
      contexts: { vault: { "Space t": "listing.next" } },
    });
    expect(saved.ok).toBe(true);
  };

  it("shows a prefix's continuations from the listing it was typed in", () => {
    scoped();
    const { release, handler } = setup();
    render(<PendingKeys />);
    act(() => {
      targeted(handler, " ", rowIn("vtree__rows"));
    });
    expect(pendingSnapshot()).toMatchObject({
      keys: ["Space"],
      context: "vault",
    });
    const which = screen.getByRole("list", { name: "Next keys" });
    expect(which.textContent).toContain("t Next row");
    release();
  });

  it("does not show it for a press in the rail, where Space is no prefix", () => {
    scoped();
    const { release, handler } = setup();
    render(<PendingKeys />);
    act(() => {
      targeted(handler, " ", rowIn("railtree"));
    });
    expect(pendingSnapshot().keys).toEqual([]);
    expect(screen.queryByRole("list", { name: "Next keys" })).toBeNull();
    // A pending state that began in the rail reads the rail's keys.
    act(() => {
      publishPending({ ...NO_PENDING, keys: ["Space"], context: "rail" });
    });
    expect(screen.queryByRole("list", { name: "Next keys" })).toBeNull();
    act(() => {
      publishPending({ ...NO_PENDING, keys: ["Space"], context: "vault" });
    });
    expect(screen.getByRole("list", { name: "Next keys" })).not.toBeNull();
    release();
  });
});
