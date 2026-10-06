/** A decoy returns to its original vault's sealed gate; ordinary guests stay guests. */
import { lastVaultIsGuest, writeLastVaultId } from "../last-vault.js";
import { GUEST_TOMB } from "../vfs.js";
import { readTombHeader } from "./store-header.js";
import { guestVaultScope, scopedVaultScope } from "./store-scope.js";

export function guestHandBack(
  ephemeralTomb: string | null,
  wasDecoy: boolean,
  recordLastVault: boolean,
) {
  const toGuest = !wasDecoy || lastVaultIsGuest();
  if (recordLastVault && toGuest) writeLastVaultId(GUEST_TOMB);
  const scope = toGuest ? guestVaultScope() : scopedVaultScope();
  const header =
    toGuest && ephemeralTomb === GUEST_TOMB ? null : readTombHeader(scope.tomb);
  return { scope, header };
}
