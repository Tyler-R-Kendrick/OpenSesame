import type { VaultHeader } from "@opensesame/vault-core";
import type { VaultPrefs } from "./prefs.js";
import { rebindTombSeals } from "./seal-rebind.js";
import { loadVaultBody } from "./store-body.js";
import { sealMark } from "./store-fresh.js";
import { loadSessionPrefs } from "./store-session-prefs.js";
import { hydrateAndMigrateTombOnUnlock } from "./tomb-migration.js";

/** Every loader remains bound to the selected real scope before the next phase. */
export async function loadActivatedVault(
  tomb: string,
  key: CryptoKey,
  header: VaultHeader | null,
  prefs: VaultPrefs,
  assertCurrent: () => void,
) {
  assertCurrent();
  await rebindTombSeals(tomb, key, assertCurrent);
  assertCurrent();
  await hydrateAndMigrateTombOnUnlock(tomb, assertCurrent);
  assertCurrent();
  const loadedPrefs = await loadSessionPrefs(tomb, prefs, assertCurrent);
  assertCurrent();
  const body = await loadVaultBody(tomb, key, header);
  assertCurrent();
  return { prefs: loadedPrefs, body, mark: sealMark(tomb) };
}
