import { useVault, useVaultStore } from "../../lib/vault/hooks.js";
import type { VaultPrefs } from "../../lib/vault/store.js";
import { VisualPrefs } from "./VisualPrefs.js";

export function GeneralPrefsPanel() {
  const store = useVaultStore();
  const { prefs } = useVault();
  const commit = (next: Partial<VaultPrefs>) => {
    void store.commitPrefs(next);
  };

  return (
    <VisualPrefs
      prefs={prefs}
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
