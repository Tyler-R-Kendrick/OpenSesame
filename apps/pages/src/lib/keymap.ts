import { type KeybindingsMap, createKeybindingsHandler } from "tinykeys";

export type ListingMotion = {
  next: (count?: number) => void;
  previous: (count?: number) => void;
  first: () => void;
  last: () => void;
  enter: () => void;
  parent: () => void;
  activate: () => void;
  page?: (direction: 1 | -1, size: "half" | "full") => void;
  edge?: (where: "high" | "mid" | "low") => void;
  focus?: () => void;
  /** 0-based. `5G` lands here instead of first()+next(4), which reshapes the rail. */
  toIndex?: (index: number) => void;
};

export type VaultKeymapTarget = ListingMotion & {
  search: () => void;
  closeSearch: () => void;
  copySecret: () => void;
  copyUsername: () => void;
  edit: () => void;
  trash: () => void;
  create: () => void;
  favorite: () => void;
  share: () => void;
};

export type RailKeymapTarget = ListingMotion;

type KeymapOptions = {
  navigate: (path: string) => void;
  showHelp: () => void;
};

let vaultTarget: VaultKeymapTarget | null = null;

export function registerVaultKeymap(target: VaultKeymapTarget): () => void {
  vaultTarget = target;
  return () => {
    if (vaultTarget === target) vaultTarget = null;
  };
}

let railTarget: RailKeymapTarget | null = null;

export function registerRailKeymap(target: RailKeymapTarget): () => void {
  railTarget = target;
  return () => {
    if (railTarget === target) railTarget = null;
  };
}

function listingOf(event: KeyboardEvent): "rail" | "vault" | null {
  const node = event.target;
  if (node instanceof Element) {
    if (node.closest(".railtree")) return "rail";
    if (node.closest(".vtree__rows")) return "vault";
  }
  return null;
}

function movementTarget(event: KeyboardEvent): ListingMotion | null {
  const listing = listingOf(event);
  if (listing === "rail") return railTarget;
  if (listing === "vault") return vaultTarget;
  return vaultTarget ?? railTarget;
}

let helpTarget: (() => void) | null = null;

/** The shell owns the keymap sheet; registering hands `?` (and any pointer twin) a way to open it. */
export function registerKeymapHelp(show: () => void): () => void {
  helpTarget = show;
  return () => {
    if (helpTarget === show) helpTarget = null;
  };
}

export function showKeymapHelp(): void {
  helpTarget?.();
}

export function focusRailListing(): void {
  railTarget?.focus?.();
}

export function focusVaultListing(): void {
  vaultTarget?.focus?.();
}

/** In-app `?` sheet. Characterization snapshots this so copy drift is a diff. */
export const KEYMAP_HELP = [
  ["j / k or arrows", "Move"],
  ["3j  10k", "Repeat a motion"],
  ["Ctrl-d / u", "Half-page"],
  ["Ctrl-f / b or PgUp/Dn", "Page"],
  ["H / M / L", "High, mid, low"],
  ["gg / G  0 / $", "First or last"],
  ["l / h  Enter  Backspace", "Dive or climb"],
  ["Tab", "Other listing"],
  ["/  Esc", "Search or focus the tree"],
  ["y / u", "Copy secret or username"],
  ["e / x", "Edit or trash"],
  ["n / .", "New or favorite"],
  ["s", "Share once"],
  ["g v/c/a/i/s", "Go to a section"],
] as const;

function typing(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    (target instanceof HTMLElement && target.isContentEditable)
  );
}

const SECTION_PATHS = new Map([
  ["v", "/vault"],
  ["c", "/connections"],
  ["a", "/access"],
  ["i", "/identity"],
  ["s", "/settings"],
]);

const COUNT_MAX = 999;

/** Vim `timeoutlen` for `g` chords. Tests may shorten it. */
export const keymapSeams = {
  goTimeoutMs: 600,
};

/**
 * tinykeys refuses events with an empty `code` (jsdom / Testing Library).
 * Production keydowns always have one; tests often pass only `key`.
 */
function ensureCode(event: KeyboardEvent): void {
  if (event.code) return;
  let code = event.key;
  if (event.key === " ") code = "Space";
  else if (event.key.length === 1 && /[a-z]/i.test(event.key)) {
    code = `Key${event.key.toUpperCase()}`;
  } else if (event.key.length === 1 && /[0-9]/.test(event.key)) {
    code = `Digit${event.key}`;
  }
  try {
    Object.defineProperty(event, "code", { configurable: true, value: code });
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

function times(n: number, run: () => void): void {
  for (let i = 0; i < n; i++) run();
}

/**
 * Bindings are a tinykeys map (`Control+d`, `Shift+G`, `ArrowDown`).
 * Counts (`5j`) and the `g` leader (`gg`, `gv`) stay a thin wrapper:
 * tinykeys sequences treat overlapping prefixes as first-complete-wins,
 * so `gga` would never jump. Adding a motion is a row, not a ternary.
 */
export function createKeymapHandler({ navigate, showHelp }: KeymapOptions) {
  let count = 0;
  let pendingGo = false;
  let goTimer: ReturnType<typeof setTimeout> | null = null;

  const clearGo = () => {
    pendingGo = false;
    if (goTimer !== null) {
      clearTimeout(goTimer);
      goTimer = null;
    }
  };

  const armGo = () => {
    pendingGo = true;
    if (goTimer !== null) clearTimeout(goTimer);
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
    "/": verb(() => vaultTarget?.search()),
    Escape: (event) => {
      count = 0;
      vaultTarget?.closeSearch();
      (movementTarget(event) ?? vaultTarget ?? railTarget)?.focus?.();
      event.preventDefault();
    },
    y: verb(() => vaultTarget?.copySecret()),
    u: verb(() => vaultTarget?.copyUsername()),
    e: verb(() => vaultTarget?.edit()),
    x: verb(() => vaultTarget?.trash()),
    n: verb(() => vaultTarget?.create()),
    ".": verb(() => vaultTarget?.favorite()),
    s: verb(() => vaultTarget?.share()),
    "Shift+?": verb(() => showHelp()),
    "?": verb(() => showHelp()),
    Tab: (event) => {
      count = 0;
      const listing = listingOf(event);
      if (!listing) return;
      const other = listing === "rail" ? vaultTarget : railTarget;
      (other ?? (listing === "rail" ? railTarget : vaultTarget))?.focus?.();
      event.preventDefault();
    },
    Space: (event) => {
      count = 0;
      if (listingOf(event)) event.preventDefault();
    },
  };

  const dispatch = createKeybindingsHandler(bindings, {
    timeout: keymapSeams.goTimeoutMs,
    ignore: () => false,
  });

  return (event: KeyboardEvent) => {
    ensureCode(event);
    if (
      event.defaultPrevented ||
      event.metaKey ||
      event.altKey ||
      typing(event.target) ||
      document.querySelector('[role="dialog"][aria-modal="true"]')
    ) {
      count = 0;
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
      if (event.key === "g") {
        const n = count;
        count = 0;
        clearGo();
        if (n > 0) goToCount(movementTarget(event), n);
        else movementTarget(event)?.first();
        event.preventDefault();
        return;
      }
      const path = SECTION_PATHS.get(event.key.toLowerCase());
      if (path) {
        count = 0;
        clearGo();
        navigate(path);
        event.preventDefault();
        return;
      }
      clearGo();
    }

    if (event.key === "g") {
      armGo();
      event.preventDefault();
      return;
    }

    dispatch(event);
  };
}
