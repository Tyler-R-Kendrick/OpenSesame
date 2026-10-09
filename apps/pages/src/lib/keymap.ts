import { contributionsSnapshot } from "@opensesame/app-core/lib/contributions.js";
import {
  REGISTER_PREFIX,
  keymapCommands,
} from "@opensesame/app-core/lib/keymap/commands.js";
import type { KeymapConfig } from "@opensesame/app-core/lib/keymap/config.js";
import type { KeymapContext } from "@opensesame/app-core/lib/keymap/context.js";
import { effectiveBindings } from "@opensesame/app-core/lib/keymap/effective.js";
import { tokenFromPress } from "@opensesame/app-core/lib/keymap/notation.js";
import { loadKeymap } from "@opensesame/app-core/lib/keymap/store.js";
import { handleCommandBarChord } from "./command-bar/focus.js";
import {
  type ChordState,
  clearPending,
  createChordState,
  registerKey,
  repeatIgnored,
  showPending,
  startRegister,
} from "./keymap-chord.js";
import { runTarget } from "./keymap-commands.js";
import {
  type KeymapView,
  contributedKeymapExtras,
  keymapHelpRows,
} from "./keymap-help.js";
import { sectionJumpKeys } from "./keymap-jumps.js";
import { recordRun } from "./keymap-registers.js";
import { type Fire, resolveToken } from "./keymap-resolve.js";
import { handlePaneEscape } from "./pane-escape.js";

import {
  capturingKeys,
  contextMenuOpen,
  currentRailTarget,
  currentSearchTarget,
  currentVaultTarget,
  listingOf,
  movementTarget,
  statusBubbleOpen,
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

export { sectionJumpKeys, sectionJumpPath } from "./keymap-jumps.js";

export {
  KEYMAP_HELP_CORE,
  type KeymapHelpRow,
  type KeymapView,
  keymapHelpRows,
  registerKeymapHelp,
  showKeymapHelp,
} from "./keymap-help.js";

/**
 * The sheet for the jumps and controls registered right now; with the keymap
 * in force, drawn from the keys a person actually has.
 */
export function keymapHelp(view?: KeymapView) {
  return keymapHelpRows(sectionJumpKeys(), contributedKeymapExtras(), view);
}

type BindingsFor = (
  context: KeymapContext | null,
) => ReadonlyMap<string, string>;

type KeymapSeams = {
  /** Vim `timeoutlen`: how long a half-typed sequence waits. */
  goTimeoutMs: number;
  /** The map the handler reads; null reads the keymap in force. */
  bindings: BindingsFor | null;
};

/** Tests may shorten the timeout, or hand the handler a map of their own. */
export const keymapSeams: KeymapSeams = {
  goTimeoutMs: 1_000, // CI keypress gap; was 600
  bindings: null,
};

const COUNT_MAX = 999;

export { type ChordState, createChordState } from "./keymap-chord.js";

let cached: {
  config: KeymapConfig;
  jumps: unknown;
  sections: unknown;
  /** One map per scope: everywhere, and each listing asked for so far. */
  maps: Map<KeymapContext | "everywhere", ReadonlyMap<string, string>>;
} | null = null;

/**
 * The keymap in force — everywhere, or with a listing's own keys laid over
 * it (ADR 0156 §6) — rebuilt only when the keymap or the jumps change.
 */
export function currentBindings(
  context?: KeymapContext | null,
): ReadonlyMap<string, string> {
  const config = loadKeymap();
  const jumps = contributionsSnapshot("keymap-jump");
  const sections = contributionsSnapshot("section");
  if (
    cached?.config !== config ||
    cached.jumps !== jumps ||
    cached.sections !== sections
  ) {
    cached = { config, jumps, sections, maps: new Map() };
  }
  const scope = context ?? "everywhere";
  let map = cached.maps.get(scope);
  if (map === undefined) {
    map = effectiveBindings(config, keymapCommands(), context ?? undefined);
    cached.maps.set(scope, map);
  }
  return map;
}

/**
 * `/claim` leaves Ctrl-l and Cmd-l to the browser address bar. A claim or
 * drop link is long, and that chord is how it is pasted from the bar. `:`
 * still opens the command bar. This is a route exception, not a keymap
 * context: contexts stay `vault` | `rail`. The path is `location`, so the
 * check does not need a host.
 */
function onClaimRoute(): boolean {
  const path = location.pathname.replace(/\/+$/, "") || "/";
  return /\/claim$/.test(path);
}

function claimRouteYieldsAddressBar(event: KeyboardEvent): boolean {
  if (event.altKey || event.shiftKey || event.isComposing) return false;
  if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "l") {
    return false;
  }
  return onClaimRoute();
}

/** Ctrl-l reaches the command bar from a field too — while it is still bound. */
function commandBarChordBound(event: KeyboardEvent): boolean {
  // On `/claim` the chord is the browser's, even from the paste field.
  if (claimRouteYieldsAddressBar(event)) return false;
  if (event.metaKey) return true;
  return (
    currentBindings(listingOf(event)).get("Control+l") === "command.palette"
  );
}

function leavePane(event: KeyboardEvent): void {
  if (statusBubbleOpen()) return;
  currentSearchTarget()?.closeSearch();
  currentVaultTarget()?.closeSearch();
  (
    movementTarget(event) ??
    currentVaultTarget() ??
    currentRailTarget()
  )?.focus?.();
  event.preventDefault();
}

function otherListing(event: KeyboardEvent): void {
  const listing = listingOf(event);
  const other = listing === "rail" ? currentVaultTarget() : currentRailTarget();
  if (!other?.focus) return;
  other.focus();
  event.preventDefault();
}

/**
 * The shell's key handler (ADR 0156). Every binding comes from the keymap in
 * force — the defaults with a person's changes — through a sequence trie:
 * counts first (`5j`), then the half-typed sequence (`g` of `g v`), which
 * waits `goTimeoutMs` like vim's `timeoutlen`. The keys that keep the
 * keyboard-only road open (Tab, Enter, Escape, F6, counts) are fixed here and
 * cannot be bound away. The shell passes one `chord` for the page's life: a
 * capability's wrapper arriving remounts it, and a `g` typed across that must
 * still land. The register keys (`q`, `@`) take the next key as a letter,
 * and a recording outlives any remount. After every press the statusline
 * hears what is half-typed.
 */
export function createKeymapHandler(
  { navigate, showHelp }: KeymapOptions,
  chord: ChordState = createChordState(),
) {
  const takeCount = () => {
    const hadCount = chord.count > 0;
    const steps = hadCount ? chord.count : 1;
    chord.count = 0;
    return { steps, hadCount };
  };

  const fire: Fire = (target, event, keys) => {
    const counted = takeCount();
    if (target.startsWith(REGISTER_PREFIX)) {
      startRegister(
        chord,
        target,
        keys,
        counted.steps,
        keymapSeams.goTimeoutMs,
      );
      return;
    }
    // A command that throws is not recorded: `recordRun` is never reached.
    runTarget(target, { event, navigate, showHelp, ...counted });
    recordRun(chord.registers, target, counted.steps);
  };

  const resolve = (
    event: KeyboardEvent,
    token: string,
    map: ReadonlyMap<string, string>,
  ) =>
    resolveToken(
      { chord, fire, map, timeoutMs: keymapSeams.goTimeoutMs },
      event,
      token,
    );

  const handle = (event: KeyboardEvent) => {
    // Control+l is also a binding. On `/claim` neither the chord nor the
    // binding may take it: the address bar has to win when nothing is typed.
    if (claimRouteYieldsAddressBar(event)) {
      chord.count = 0;
      clearPending(chord);
      return;
    }
    if (heldElsewhere(event) || standsDown(event)) {
      chord.count = 0;
      clearPending(chord);
      return;
    }
    const map = (keymapSeams.bindings ?? currentBindings)(listingOf(event));
    if (repeatIgnored(event, chord, map)) {
      event.preventDefault();
      return;
    }
    if (registerKey(event, chord, { navigate, showHelp })) return;
    if (countKey(event, chord)) return;
    if (fixedKey(event)) {
      chord.count = 0;
      clearPending(chord);
      return;
    }
    const token = tokenFromPress(event);
    if (token === null) return;
    if (resolve(event, token, map)) return;
    chord.count = 0;
    // An unbound Space in a listing must not scroll the page under the cursor.
    if (token === "Space" && listingOf(event)) event.preventDefault();
  };

  // The statusline hears the outcome even when a command threw.
  return (event: KeyboardEvent) => {
    try {
      handle(event);
    } finally {
      showPending(chord);
    }
  };
}

/**
 * Something else owns this press: a key-capture field (Settings ›
 * Keybindings), the Escape ladder, or the command bar's own chord.
 */
/**
 * A live tutorial owns Escape (ADR 0163): the coach leaves the tour from the
 * card or the lit control, or lets the topmost sheet close first. The keymap
 * must not move focus out from under it, whichever listener the browser runs
 * first, so it stands down for an Escape that is not a field's own.
 */
function coachHoldsEscape(event: KeyboardEvent): boolean {
  return (
    event.key === "Escape" &&
    !typing(event.target) &&
    document.querySelector(".coach") !== null
  );
}

function heldElsewhere(event: KeyboardEvent): boolean {
  if (capturingKeys(event.target)) return true;
  if (handlePaneEscape(event)) return true;
  if (coachHoldsEscape(event)) return true;
  // An open context menu owns every key until it closes.
  return (
    !contextMenuOpen() &&
    commandBarChordBound(event) &&
    handleCommandBarChord(event)
  );
}

/** A native control, a field, a menu or a dialog keeps its own keys. */
function standsDown(event: KeyboardEvent): boolean {
  return Boolean(
    contextMenuOpen() ||
      event.defaultPrevented ||
      event.isComposing ||
      event.metaKey ||
      // Alt, Option and AltGr make symbols on many layouts (`@`): those are
      // characters, and only an Alt shortcut stands down.
      (event.altKey && tokenFromPress(event) === null) ||
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
      document.querySelector('[role="dialog"][aria-modal="true"]'),
  );
}

/** `1`–`9` start or extend a count; `0` extends one already started. */
function countKey(event: KeyboardEvent, chord: ChordState): boolean {
  if (event.ctrlKey) return false;
  const digit = event.key >= "1" && event.key <= "9";
  if (!digit && !(event.key === "0" && chord.count > 0)) return false;
  chord.count = Math.min(chord.count * 10 + Number(event.key), COUNT_MAX);
  event.preventDefault();
  return true;
}

/** The keys no keymap may take: Escape, F6 and Enter (ADR 0156). */
function fixedKey(event: KeyboardEvent): boolean {
  if (event.key === "Escape") {
    leavePane(event);
    return true;
  }
  if (event.key === "F6") {
    otherListing(event);
    return true;
  }
  if (event.key !== "Enter" || event.shiftKey || event.ctrlKey) return false;
  const listing = movementTarget(event);
  if (!listingOf(event)) listing?.focus?.();
  listing?.activate();
  event.preventDefault();
  return true;
}
