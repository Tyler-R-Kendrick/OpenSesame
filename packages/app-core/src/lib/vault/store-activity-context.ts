/** Keyless activity metadata, never an unlock or permission issuer. */
import { activitySeams } from "../activity-log.js";
import type { VaultState } from "./store-state.js";
export function installVaultActivityContext(snapshot: () => VaultState): void {
  activitySeams.activeTomb = () => {
    const state = snapshot();
    return state.status === "unlocked" && state.tomb ? state.tomb : null;
  };
}
