import { useCallback, useEffect, useSyncExternalStore } from "react";
import { vaultStore, type VaultState } from "./store.js";

export function useVault(): VaultState {
  return useSyncExternalStore(vaultStore.subscribe, vaultStore.getSnapshot);
}

export function useVaultStore() {
  return vaultStore;
}

/** Keep the idle clock honest and lock on tab hide when the user asked for it. */
export function useSessionGuards(): void {
  const { prefs, status } = useVault();

  useEffect(() => {
    if (status !== "unlocked") return;
    const touch = () => vaultStore.touch();
    const events = ["pointerdown", "keydown", "focus"] as const;
    for (const event of events) window.addEventListener(event, touch, true);
    return () => {
      for (const event of events) window.removeEventListener(event, touch, true);
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

/**
 * Copy a secret and schedule a clipboard clear. The clear only fires if the
 * clipboard still holds what we put there, so we never wipe the user's own copy.
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
      if (prefs.clipboardClearSeconds > 0) {
        window.setTimeout(() => {
          void (async () => {
            try {
              const current = await navigator.clipboard.readText();
              if (current === value) await navigator.clipboard.writeText("");
            } catch {
              /* clipboard-read permission denied — leave the user's clipboard alone */
            }
          })();
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
