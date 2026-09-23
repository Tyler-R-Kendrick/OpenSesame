import { dispatchUserBinding } from "@opensesame/app-core/lib/configuration/nav-persist.js";
import { contributionsSnapshot } from "@opensesame/app-core/lib/contributions.js";
import { type KeybindingsMap, createKeybindingsHandler } from "tinykeys";
import {
  focusCommandBar,
  handleCommandBarChord,
  toggleCommandBarMic,
} from "./command-bar/focus.js";
import { keymapHelpRows } from "./keymap-help.js";
import { handlePaneEscape } from "./pane-escape.js";

import {
  type ListingMotion,
  currentRailTarget,
  currentSearchTarget,
  currentVaultTarget,
  listingOf,
  movementTarget,
  typing,
} from "./keymap-targets.js";

export {
  type ListingMotion,
  type RailKeymapTarget,
  type SearchKeymapTarget,
  type VaultKeymapTarget,
  focusRailListing,
  focusVaultListing,
  registerRailKeymap,
  registerSearchKeymap,
  registerVaultKeymap,
  typing,
} from "./keymap-targets.js";

type KeymapOptions = {
  navigate: (path: string) => void;
  showHelp: () => void;
};

export {
  KEYMAP_HELP_CORE,
  type KeymapHelpRow,
  keymapHelpRows,
  registerKeymapHelp,
  showKeymapHelp,
} from "./keymap-help.js";

/** The sheet for the jumps registered right now. */
export function keymapHelp() {
  return keymapHelpRows(sectionJumpKeys());
}

/**
 * The `g` jumps the core shell always has. Every other letter is a
 * `keymap-jump` contribution from the capability whose section it opens, so
 * a letter for an excluded capability is not bound at all (SURFACE-09).
 */
const CORE_JUMPS: ReadonlyMap<string, string> = new Map([
  ["v", "/vault"],
  ["s", "/settings"],
]);

/** The path `g <key>` opens, or null when nothing registered that key. */
export function sectionJumpPath(key: string): string | null {
  const core = CORE_JUMPS.get(key);
  if (core !== undefined) return core;
  return (
    contributionsSnapshot("keymap-jump").find((jump) => jump.key === key)
      ?.path ?? null
  );
}

/** Every jump key that exists right now, in the rail's order. */
export function sectionJumpKeys(): readonly string[] {
  const sections = contributionsSnapshot("section");
  const orderOf = (path: string): number =>
    path === "/vault"
      ? 0
      : path === "/settings"
        ? 1000
        : (sections.find((section) => section.to === path)?.order ?? 500);
  const jumps = new Map<string, string>(CORE_JUMPS);
  for (const jump of contributionsSnapshot("keymap-jump")) {
    if (!jumps.has(jump.key)) jumps.set(jump.key, jump.path);
  }
  return [...jumps]
    .sort(([, left], [, right]) => orderOf(left) - orderOf(right))
    .map(([key]) => key);
}

/** Listing motions that keep their meaning after a `g`: `gj` is still down. */
const GO_MOTIONS = new Set(["j", "k", "h", "l"]);

const COUNT_MAX = 999;

/** Vim `timeoutlen` for `g` chords. Tests may shorten it. */
export const keymapSeams = {
  goTimeoutMs: 1_000, // CI keypress gap; was 600
};

/**
 * tinykeys refuses events with an empty `code` (jsdom / Testing Library).
 * Production keydowns always have one; tests often pass only `key`.
 */
function ensureCode(event: KeyboardEvent): void {
  const code = event.key === " " ? "Space" : event.key;
  try {
    Object.defineProperty(event, "code", { value: code });
  } catch {
    // Some engines expose `code` as a readonly getter; matching still uses `key`.
  }
}

function goToCount(target: ListingMotion | null, n: number): void {
  if (!target) return;
  if (target.toIndex) {
    target.toIndex(Math.max(0, n - 1));
    return;
  }
  target.first();
  if (n > 1) target.next(n - 1);
}

function applyGoChord(
  event: KeyboardEvent,
  count: number,
  navigate: (path: string) => void,
): boolean {
  if (event.key === "g") {
    if (count > 0) goToCount(movementTarget(event), count);
    else movementTarget(event)?.first();
    event.preventDefault();
    return true;
  }
  const key = event.key.toLowerCase();
  const path = sectionJumpPath(key);
  if (path === null) {
    // A letter that is no jump on this plan is swallowed, not reinterpreted:
    // a stale `g y` must not become `y` (copy the secret) because the
    // activity capability left. Motions keep working after a `g`.
    if (/^[a-z]$/.test(key) && !GO_MOTIONS.has(key)) {
      event.preventDefault();
      return true;
    }
    return false;
  }
  const rail = currentRailTarget();
  if (rail?.goTo) {
    rail.goTo(path);
    rail.focus?.();
  } else navigate(path);
  event.preventDefault();
  return true;
}

function times(n: number, run: () => void): void {
  for (let i = 0; i < n; i++) run();
}

/** tinykeys map plus counts/`g` leader; remappable actions use liveBindings. */
export function createKeymapHandler({ navigate, showHelp }: KeymapOptions) {
  let count = 0;
  let pendingGo = false;
  let goTimer: ReturnType<typeof setTimeout> | undefined;

  const clearGo = () => {
    pendingGo = false;
    clearTimeout(goTimer);
    goTimer = undefined;
  };

  const armGo = () => {
    pendingGo = true;
    goTimer = setTimeout(clearGo, keymapSeams.goTimeoutMs);
  };

  const takeCount = () => {
    const hadCount = count > 0;
    const steps = hadCount ? count : 1;
    count = 0;
    return { steps, hadCount };
  };

  const run = (
    fn: (
      listing: ListingMotion | null,
      steps: number,
      hadCount: boolean,
    ) => void,
  ) => {
    return (event: KeyboardEvent) => {
      const listing = movementTarget(event);
      if (!listingOf(event)) listing?.focus?.();
      const { steps, hadCount } = takeCount();
      fn(listing, steps, hadCount);
      event.preventDefault();
    };
  };

  const verb = (fn: () => void) => (event: KeyboardEvent) => {
    count = 0;
    fn();
    event.preventDefault();
  };

  const bindings: KeybindingsMap = {
    j: run((listing, steps) => listing?.next(steps)),
    ArrowDown: run((listing, steps) => listing?.next(steps)),
    k: run((listing, steps) => listing?.previous(steps)),
    ArrowUp: run((listing, steps) => listing?.previous(steps)),
    l: run((listing, steps) => times(steps, () => listing?.enter())),
    ArrowRight: run((listing, steps) => times(steps, () => listing?.enter())),
    h: run((listing, steps) => times(steps, () => listing?.parent())),
    ArrowLeft: run((listing, steps) => times(steps, () => listing?.parent())),
    Backspace: run((listing, steps) => times(steps, () => listing?.parent())),
    "Shift+G": run((listing, steps, hadCount) =>
      hadCount ? goToCount(listing, steps) : listing?.last(),
    ),
    "Shift+$": run((listing) => listing?.last()),
    $: run((listing) => listing?.last()),
    End: run((listing) => listing?.last()),
    Home: run((listing) => listing?.first()),
    "Shift+H": run((listing) => listing?.edge?.("high")),
    "Shift+M": run((listing) => listing?.edge?.("mid")),
    "Shift+L": run((listing) => listing?.edge?.("low")),
    PageDown: run((listing, steps) =>
      times(steps, () => listing?.page?.(1, "full")),
    ),
    PageUp: run((listing, steps) =>
      times(steps, () => listing?.page?.(-1, "full")),
    ),
    "Control+d": run((listing, steps) =>
      times(steps, () => listing?.page?.(1, "half")),
    ),
    "Control+u": run((listing, steps) =>
      times(steps, () => listing?.page?.(-1, "half")),
    ),
    "Control+f": run((listing, steps) =>
      times(steps, () => listing?.page?.(1, "full")),
    ),
    "Control+b": run((listing, steps) =>
      times(steps, () => listing?.page?.(-1, "full")),
    ),
    "Control+n": run((listing, steps) => listing?.next(steps)),
    "Control+p": run((listing, steps) => listing?.previous(steps)),
    Enter: run((listing) => listing?.activate()),
    "/": verb(() => (currentSearchTarget() ?? currentVaultTarget())?.search()),
    Escape: (event) => {
      count = 0;
      currentSearchTarget()?.closeSearch();
      currentVaultTarget()?.closeSearch();
      (
        movementTarget(event) ??
        currentVaultTarget() ??
        currentRailTarget()
      )?.focus?.();
      event.preventDefault();
    },
    y: verb(() => currentVaultTarget()?.copySecret()),
    u: verb(() => currentVaultTarget()?.copyUsername()),
    e: verb(() => currentVaultTarget()?.edit()),
    x: verb(() => currentVaultTarget()?.trash()),
    n: verb(() => currentVaultTarget()?.create()),
    ".": verb(() => currentVaultTarget()?.favorite()),
    s: verb(() => currentVaultTarget()?.share()),
    "Shift+?": verb(() => showHelp()),
    "?": verb(() => showHelp()),
    ":": verb(() => focusCommandBar()),
    m: verb(() => toggleCommandBarMic()),
    F6: (event) => {
      count = 0;
      const listing = listingOf(event);
      const other =
        listing === "rail" ? currentVaultTarget() : currentRailTarget();
      if (!other?.focus) return;
      other.focus();
      event.preventDefault();
    },
    Space: (event) => {
      count = 0;
      if (listingOf(event)) event.preventDefault();
    },
  };

  const dispatch = createKeybindingsHandler(bindings, {
    ignore: (event) => event.isComposing,
  });

  return (event: KeyboardEvent) => {
    ensureCode(event);
    if (handlePaneEscape(event)) {
      count = 0;
      clearGo();
      return;
    }
    if (handleCommandBarChord(event)) {
      count = 0;
      clearGo();
      return;
    }
    if (
      event.defaultPrevented ||
      event.metaKey ||
      event.altKey ||
      event.key === "Tab" ||
      typing(event.target) ||
      (event.target instanceof Element &&
        event.target.closest('a[href], button, summary, [role="button"]') &&
        ["Enter", " "].includes(event.key)) ||
      (event.target instanceof Element &&
        event.target.closest(
          '[role="tab"], [role="menuitem"], [role="slider"], [role="radio"]',
        ) &&
        [
          "Enter",
          " ",
          "ArrowUp",
          "ArrowDown",
          "ArrowLeft",
          "ArrowRight",
          "Home",
          "End",
        ].includes(event.key)) ||
      document.querySelector('[role="dialog"][aria-modal="true"]')
    ) {
      count = 0;
      clearGo();
      return;
    }

    if (!event.ctrlKey && event.key >= "1" && event.key <= "9") {
      count = Math.min(count * 10 + Number(event.key), COUNT_MAX);
      event.preventDefault();
      return;
    }
    if (!event.ctrlKey && event.key === "0") {
      if (count > 0) {
        count = Math.min(count * 10, COUNT_MAX);
        event.preventDefault();
        return;
      }
      clearGo();
      movementTarget(event)?.first();
      event.preventDefault();
      return;
    }

    if (pendingGo) {
      if (applyGoChord(event, count, navigate)) {
        count = 0;
        clearGo();
        return;
      }
      clearGo();
    }

    if (event.key === "g") {
      armGo();
      event.preventDefault();
      return;
    }

    if (
      dispatchUserBinding(event, false, {
        "command.palette": () => focusCommandBar(),
        "listing.search": () =>
          (currentSearchTarget() ?? currentVaultTarget())?.search(),
        "listing.next": (ev) => movementTarget(ev)?.next(takeCount().steps),
        "item.edit": () => currentVaultTarget()?.edit(),
        "help.keymap": () => showHelp(),
      })
    ) {
      count = 0;
      return;
    }

    dispatch(event);
  };
}
