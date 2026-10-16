import type { SavedTailscaleApp } from "@opensesame/app-core/lib/tailscale/store.js";
import { useEffect } from "react";
import { tailscaleAppDependencies as deps } from "./tailscale-dependencies.js";
function currentSecret(saved: SavedTailscaleApp): string {
  const vault = deps.session();
  try {
    deps.assertTailscaleAppCurrent(saved);
    return deps.openTailscaleApp(saved, vault.current().tomb).clientSecret;
  } finally {
    vault.close();
  }
}
/** Actual vault credential edits invalidate transient results even when metadata refs stay fixed. */
export function useTailscaleCredentialLifetime(
  saved: SavedTailscaleApp | null,
  clear: () => void,
) {
  useEffect(() => {
    if (!saved) return;
    let expected: string;
    try {
      expected = currentSecret(saved);
    } catch {
      clear();
      return;
    }
    return deps.onVaultChange(() => {
      try {
        if (currentSecret(saved) !== expected) clear();
      } catch {
        clear();
      }
    });
  }, [saved, clear]);
}
