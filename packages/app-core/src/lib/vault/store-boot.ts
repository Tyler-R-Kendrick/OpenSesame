/** Vault store singleton wiring (ADR 0160 device key carrier, activity tomb seam). */
import { activitySeams } from "../activity-log.js";
import { installSignInPrfVault } from "../local-passkey-prf.js";
import { bodyPortOf, installDeviceKeyCarrier } from "./store-device-key.js";
import type { VaultStore } from "./store.js";

export function installVaultStoreBoot(store: VaultStore): void {
  installDeviceKeyCarrier(() => bodyPortOf(store));
  installSignInPrfVault({
    isUnlocked: () => store.isUnlocked(),
    activeTomb: () => store.activeTomb(),
    get protection() {
      return store.protection;
    },
  });
  activitySeams.activeTomb = () => {
    const snap = store.getSnapshot();
    return snap.status === "unlocked" && snap.tomb ? snap.tomb : null;
  };
}
