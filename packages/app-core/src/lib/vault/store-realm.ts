/** Only the store that opened a synthetic realm can dismiss its presentation. */
import {
  assertAuthenticationSession,
  currentRealmGeneration,
  freshOwnerAuthenticationTomb,
  isDecoySession,
  markDecoySession,
} from "../decoy-session.js";
import { refuseWhileFrozen } from "../duress/hold/gate.js";
import { lastVaultIsGuest } from "../last-vault.js";
import { guestVaultScope, scopedVaultScope } from "./store-scope.js";
export function restoredLockedScope() {
  return freshOwnerAuthenticationTomb() !== null || !lastVaultIsGuest()
    ? scopedVaultScope()
    : guestVaultScope();
}
export function beginGuestRealm(
  synthetic: boolean,
  ownerTomb: string,
  ownerVaultIdentity: string | null,
): number | null {
  assertAuthenticationSession();
  markDecoySession(synthetic, ownerTomb, ownerVaultIdentity ?? undefined);
  return synthetic ? currentRealmGeneration() : null;
}
export function endStoreRealm(ownedSyntheticRealm: number | null): boolean {
  if (isDecoySession() && ownedSyntheticRealm !== currentRealmGeneration())
    return false;
  return markDecoySession(false);
}

export function refuseFrozenPrimaryProof(
  tomb: string,
  recordMiss: () => void,
  isUnlocked: () => boolean,
  cancelChallenge: () => void,
  miss?: string,
): void {
  refuseWhileFrozen(
    tomb,
    () => {
      recordMiss();
      if (!isUnlocked()) cancelChallenge();
    },
    miss,
  );
}
