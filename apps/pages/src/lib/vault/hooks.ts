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

  // Locking means locked: drop the clipboard copy, revoke the Identity session
  // (bearer, cookie, and derived Host session) and discard staged claim tokens,
  // or control-plane and Host actions stay possible behind the unlock screen.
  useEffect(
    () =>
      vaultStore.onLock(() => {
        clearCopiedSecret();
        endSession();
        clearStagedClaimTokens();
      }),
    [],
  );

  useEffect(() => {
    if (status !== "unlocked") return;
    const touch = () => vaultStore.touch();
    const events = ["pointerdown", "keydown", "focus"] as const;
    for (const event of events) window.addEventListener(event, touch, true);
    return () => {
      for (const event of events)
        window.removeEventListener(event, touch, true);
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
