import { useCallback, useEffect, useSyncExternalStore } from "react";
import { endSession } from "../identity.js";
import { clearStagedClaimTokens } from "../queue.js";
import { type VaultState, vaultStore } from "./store.js";

export function useVault(): VaultState {
  return useSyncExternalStore(vaultStore.subscribe, vaultStore.getSnapshot);
}

export function useVaultStore() {
  return vaultStore;
}

/** Keep the idle clock honest and lock on tab hide when the user asked for it. */
export function useSessionGuards(): void {
  const { prefs, status } = useVault();

  // Locking drops in-memory vault keys and clears secrets that left the vault
  // (clipboard, staged claim tokens). Identity/Host stay signed in unless the
  // operator opted into "sign out on lock" — idle vault lock must not kick
  // them out of every plane.
  useEffect(
    () =>
      vaultStore.onLock(() => {
        clearCopiedSecret();
        clearStagedClaimTokens();
        if (vaultStore.getSnapshot().prefs.signOutOnLock) {
          endSession();
        }
      }),
    [],
  );

  useEffect(() => {
    if (status !== "unlocked") return;
    const touch = () => vaultStore.touch();
    // Reading/scrolling counts as activity — not only clicks and keypresses.
    const events = [
      "pointerdown",
      "pointermove",
      "keydown",
      "scroll",
      "wheel",
      "touchstart",
      "focus",
    ] as const;
    let moveArmed = true;
    const onMove = () => {
      if (!moveArmed) return;
      moveArmed = false;
      touch();
      window.setTimeout(() => {
        moveArmed = true;
      }, 15_000);
    };
    for (const event of events) {
      if (event === "pointermove") {
        window.addEventListener(event, onMove, { capture: true, passive: true });
      } else {
        window.addEventListener(event, touch, { capture: true, passive: true });
      }
    }
    const onVisible = () => {
      if (document.visibilityState === "visible") touch();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      for (const event of events) {
        if (event === "pointermove") {
          window.removeEventListener(event, onMove, true);
        } else {
          window.removeEventListener(event, touch, true);
        }
      }
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [status]);

  useEffect(() => {
    if (status !== "unlocked" || !prefs.lockOnHide) return;
    const onHide = () => {
      if (document.visibilityState === "hidden") vaultStore.lock();
    };
    document.addEventListener("visibilitychange", onHide);
    return () => document.removeEventListener("visibilitychange", onHide);
  }, [status, prefs.lockOnHide]);
}

export type CopyResult = "copied" | "unavailable";

/** Last value this app put on the clipboard, so lock can wipe it. */
let lastCopied: string | null = null;
let pendingClear: number | null = null;

async function clearIfOurs(value: string): Promise<void> {
  try {
    const current = await navigator.clipboard.readText();
    if (current === value) await navigator.clipboard.writeText("");
  } catch {
    // Clipboard read is often denied. Clearing unconditionally is the safer
    // failure mode for a secret we ourselves just wrote.
    try {
      await navigator.clipboard.writeText("");
    } catch {
      /* clipboard unavailable — nothing further we can do */
    }
  }
  if (lastCopied === value) lastCopied = null;
}

/** Wipe anything this app copied. Called on vault lock. */
export function clearCopiedSecret(): void {
  if (pendingClear !== null) {
    window.clearTimeout(pendingClear);
    pendingClear = null;
  }
  const value = lastCopied;
  if (value === null) return;
  void clearIfOurs(value);
}

/**
 * Copy a secret and schedule a clipboard clear. Also cleared when the vault
 * locks, so a copied password does not outlive the unlocked session.
 */
export function useCopySecret(): (value: string) => Promise<CopyResult> {
  const { prefs } = useVault();
  return useCallback(
    async (value: string) => {
      if (!navigator.clipboard?.writeText) return "unavailable";
      try {
        await navigator.clipboard.writeText(value);
      } catch {
        return "unavailable";
      }
      lastCopied = value;
      if (pendingClear !== null) window.clearTimeout(pendingClear);
      pendingClear = null;
      if (prefs.clipboardClearSeconds > 0) {
        pendingClear = window.setTimeout(() => {
          pendingClear = null;
          void clearIfOurs(value);
        }, prefs.clipboardClearSeconds * 1000);
      }
      return "copied";
    },
    [prefs.clipboardClearSeconds],
  );
}

export function useTheme(): void {
  const { prefs } = useVault();
  useEffect(() => {
    const root = document.documentElement;
    if (prefs.theme === "system") root.removeAttribute("data-theme");
    else root.setAttribute("data-theme", prefs.theme);
  }, [prefs.theme]);
}
