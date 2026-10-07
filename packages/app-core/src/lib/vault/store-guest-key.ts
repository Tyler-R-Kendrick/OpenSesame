import { mintVaultKey } from "@opensesame/vault-core";
import {
  DECOY_SCRATCH_TOMB,
  clearDecoyScratch,
  decoyScratchScope,
  forgetDecoyScratch,
  guestTombIsSealed,
} from "../duress/store/decoy-scratch.js";
import { clearGuestConnections } from "../guest-connections.js";
import { lockTomb } from "../vfs.js";
import { guestVaultScope } from "./store-scope.js";
import { discardVaultBody, wipeTombOnDestroy } from "./tomb-migration.js";

export async function prepareGuestSession(
  options:
    | { resume?: boolean; decoy?: boolean; isolated?: boolean }
    | undefined,
  assertCurrent: () => void,
) {
  assertCurrent();
  const scratch =
    options?.decoy === true && (options.isolated || guestTombIsSealed());
  const scope = scratch ? decoyScratchScope() : guestVaultScope();
  if (!options?.resume && !scratch) clearGuestConnections();
  forgetDecoyScratch(scope.tomb);
  lockTomb(scope.tomb);
  return { ...(await mintGuestSessionKey(scope.tomb, assertCurrent)), scope };
}

/** Cleanup is bound to the selected guest tomb, never the store's future scope. */
export async function mintGuestSessionKey(
  tomb: string,
  assertCurrent: () => void,
) {
  assertCurrent();
  if (tomb === DECOY_SCRATCH_TOMB) {
    await clearDecoyScratch(assertCurrent);
  } else {
    await wipeTombOnDestroy(tomb);
    assertCurrent();
    await discardVaultBody(tomb);
  }
  assertCurrent();
  const keys = await mintVaultKey();
  try {
    assertCurrent();
    return keys;
  } catch (error) {
    keys.rawVaultKey.fill(0);
    throw error;
  }
}
