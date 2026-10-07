/** Session consumers read the current snapshot, never an old authorization flag. */
import { activitySeams } from "../activity-log.js";
import { retiredCredentialOwnerSeams } from "../retired-credentials/owner-auth.js";
import type { VaultState } from "./store-state.js";

export function installVaultSessionHooks(snapshot: () => VaultState): void {
  // A guest's activity belongs to its own sealed tomb.
  activitySeams.activeTomb = () => {
    const state = snapshot();
    return state.status === "unlocked" && state.tomb ? state.tomb : null;
  };
  // Password proof is sufficient only in an already authenticated real session.
  retiredCredentialOwnerSeams.isRealOwner = (tomb) => {
    const state = snapshot();
    return (
      state.status === "unlocked" &&
      !state.guest &&
      !state.decoy &&
      state.tomb === tomb
    );
  };
}
