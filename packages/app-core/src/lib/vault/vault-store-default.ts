import { activitySeams } from "../activity-log.js";
import { bodyPortOf, installDeviceKeyCarrier } from "./store-device-key.js";
import { VaultStore } from "./store.js";

export const vaultStore = new VaultStore();

installDeviceKeyCarrier(() => bodyPortOf(vaultStore));

activitySeams.activeTomb = () => {
  const snap = vaultStore.getSnapshot();
  return snap.status === "unlocked" && snap.tomb ? snap.tomb : null;
};
