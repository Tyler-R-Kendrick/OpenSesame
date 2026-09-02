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

/** Vim `timeoutlen` for the `g` chord. Tests may shorten it. */
export const keymapSeams = {
  goTimeoutMs: 600,
};

export function createKeymapHandler({ navigate, showHelp }: KeymapOptions) {
  let pendingGo = false;
  let count = 0;
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

  const goToCount = (target: ListingMotion | null, n: number) => {
    if (!target) return;
    if (target.toIndex) {
      target.toIndex(Math.max(0, n - 1));
      return;
    }
    target.first();
    if (n > 1) target.next(n - 1);
  };

  return (event: KeyboardEvent) => {
    if (
      event.defaultPrevented ||
      event.metaKey ||
      event.altKey ||
      typing(event.target) ||
      document.querySelector('[role="dialog"][aria-modal="true"]')
    ) {
      clearGo();
      count = 0;
      return;
    }

    if (event.ctrlKey) {
      const target = movementTarget(event);
      const { steps } = takeCount();
      const key = event.key.toLowerCase();
      const repeat = (run: () => void) => {
        for (let i = 0; i < steps; i++) run();
      };
      const ctrl =
        key === "d"
          ? () => repeat(() => target?.page?.(1, "half"))
          : key === "u"
            ? () => repeat(() => target?.page?.(-1, "half"))
            : key === "f"
              ? () => repeat(() => target?.page?.(1, "full"))
              : key === "b"
                ? () => repeat(() => target?.page?.(-1, "full"))
                : key === "n"
                  ? () => target?.next(steps)
                  : key === "p"
                    ? () => target?.previous(steps)
                    : undefined;
      if (!ctrl) {
        clearGo();
        count = 0;
        return;
      }
      clearGo();
      ctrl();
      event.preventDefault();
      return;
    }

    if (event.key >= "1" && event.key <= "9") {
      count = Math.min(count * 10 + Number(event.key), COUNT_MAX);
      event.preventDefault();
      return;
    }
    if (event.key === "0") {
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
      // Failed `g` chord: drop `g`, keep the count, and treat this key as itself.
      clearGo();
    }

    if (event.key === "g") {
      armGo();
      event.preventDefault();
      return;
    }

    if (event.key === "Tab") {
      const listing = listingOf(event);
      if (!listing) return;
      const other = listing === "rail" ? vaultTarget : railTarget;
      (other ?? (listing === "rail" ? railTarget : vaultTarget))?.focus?.();
      event.preventDefault();
      return;
    }

    if (event.key === " " && listingOf(event)) {
      event.preventDefault();
      return;
    }

    const target = movementTarget(event);
    const { steps, hadCount } = takeCount();
    const action =
      event.key === "j" || event.key === "ArrowDown"
        ? () => target?.next(steps)
        : event.key === "k" || event.key === "ArrowUp"
          ? () => target?.previous(steps)
          : event.key === "l" || event.key === "ArrowRight"
            ? () => {
                for (let i = 0; i < steps; i++) target?.enter();
              }
            : event.key === "h" ||
                event.key === "ArrowLeft" ||
                event.key === "Backspace"
              ? () => {
                  for (let i = 0; i < steps; i++) target?.parent();
                }
              : event.key === "G"
                ? () => (hadCount ? goToCount(target, steps) : target?.last())
                : event.key === "$" || event.key === "End"
                  ? () => target?.last()
                  : event.key === "Home"
                    ? () => target?.first()
                    : event.key === "H"
                      ? () => target?.edge?.("high")
                      : event.key === "M"
                        ? () => target?.edge?.("mid")
                        : event.key === "L"
                          ? () => target?.edge?.("low")
                          : event.key === "PageDown"
                            ? () => target?.page?.(1, "full")
                            : event.key === "PageUp"
                              ? () => target?.page?.(-1, "full")
                              : event.key === "Enter"
                                ? () => target?.activate()
                                : event.key === "/"
                                  ? () => vaultTarget?.search()
                                  : event.key === "Escape"
                                    ? () => {
                                        vaultTarget?.closeSearch();
                                        (
                                          target ??
                                          vaultTarget ??
                                          railTarget
                                        )?.focus?.();
                                      }
                                    : event.key === "y"
                                      ? () => vaultTarget?.copySecret()
                                      : event.key === "u"
                                        ? () => vaultTarget?.copyUsername()
                                        : event.key === "e"
                                          ? () => vaultTarget?.edit()
                                          : event.key === "x"
                                            ? () => vaultTarget?.trash()
                                            : event.key === "n"
                                              ? () => vaultTarget?.create()
                                              : event.key === "."
                                                ? () => vaultTarget?.favorite()
                                                : event.key === "s"
                                                  ? () => vaultTarget?.share()
                                                  : event.key === "?"
                                                    ? showHelp
                                                    : undefined;

    if (!action) return;
    action();
    event.preventDefault();
  };
}
