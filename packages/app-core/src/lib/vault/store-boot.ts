import { activitySeams } from "../activity-log.js";
import { bodyPortOf, installDeviceKeyCarrier } from "./store-device-key.js";
import type { VaultStore } from "./store.js";

export function installVaultStoreBoot(store: VaultStore): void {
  installDeviceKeyCarrier(() => bodyPortOf(store));
  activitySeams.activeTomb = () => {
    const snap = store.getSnapshot();
    return snap.status === "unlocked" && snap.tomb ? snap.tomb : null;
  };
}
