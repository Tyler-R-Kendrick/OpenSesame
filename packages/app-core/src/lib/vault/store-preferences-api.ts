/** Preferences are body-local; callbacks retain the Store's session and write lifecycle. */
import {
  readPrefsSourceFile,
  writePrefsJson,
  writePrefsSourceFile,
} from "./prefs-io.js";
import {
  VAULT_PREFS_REVISION,
  type VaultPrefs,
  normalizeVaultPrefs,
} from "./prefs.js";
import type { StorePreferences } from "./store-preferences.js";
export function createStorePreferencesApi(
  input: Readonly<{
    preferences: StorePreferences;
    open: () => boolean;
    tomb: () => string;
    changed: () => void;
  }>,
) {
  const requireOpen = () => {
    if (!input.open())
      throw new Error("Unlock the vault before saving preferences.");
  };
  const setPrefs = (next: Partial<VaultPrefs>) => {
    input.preferences.prefs = normalizeVaultPrefs({
      ...input.preferences.prefs,
      ...next,
      prefsRevision: VAULT_PREFS_REVISION,
    });
    input.changed();
  };
  return {
    setPrefs,
    async commitPrefs(next: Partial<VaultPrefs>) {
      requireOpen();
      setPrefs(next);
      await writePrefsJson(input.tomb(), input.preferences.prefs);
    },
    async writePrefsSource(source: string) {
      requireOpen();
      await writePrefsSourceFile(input.tomb(), source);
    },
    async readPrefsSource() {
      return input.open() ? readPrefsSourceFile(input.tomb()) : null;
    },
  };
}
