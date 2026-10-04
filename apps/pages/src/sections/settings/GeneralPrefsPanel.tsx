import type { VaultPrefs } from "@opensesame/app-core/lib/vault/store.js";
import { useIdentitySession } from "../../bindings/identity.js";
import { useIdentityPlane } from "../../lib/use-configured.js";
import { useVault, useVaultStore } from "../../lib/vault/hooks.js";
import { VisualPrefs } from "./VisualPrefs.js";

export function GeneralPrefsPanel() {
  const store = useVaultStore();
  const { prefs } = useVault();
  const plane = useIdentityPlane();
  const session = useIdentitySession();
  // Signing out of Identity means something where a service is named (a
  // session can come and go) or a session is held, on this device or not.
  // A device with no session yet has nothing to sign out of (ADR 0160).
  const identity = plane === "remote" || session !== null;
  const commit = (next: Partial<VaultPrefs>) => {
    void store.commitPrefs(next);
  };

  return (
    <VisualPrefs
      prefs={prefs}
      identity={identity}
      onTheme={(id) => commit({ theme: id })}
      onNumber={(key, value) => {
        if (key === "autoLockMinutes") {
          commit({ autoLockMinutes: value });
          return;
        }
        commit({ clipboardClearSeconds: value });
      }}
      onToggle={(key, value) => {
        if (key === "lockOnHide") {
          commit({ lockOnHide: value });
          return;
        }
        commit({ signOutOnLock: value });
      }}
    />
  );
}
