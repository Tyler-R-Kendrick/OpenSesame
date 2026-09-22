import { useMemo, useSyncExternalStore } from "react";
import {
  type DeviceVault,
  deviceVaultsVersion,
  listDeviceVaults,
  subscribeDeviceVaults,
} from "../lib/vaults.js";

/** The one device-vault list (ADR 0089), re-read only when the store or projects emit. */
export function useDeviceVaults(): DeviceVault[] {
  const version = useSyncExternalStore(
    subscribeDeviceVaults,
    deviceVaultsVersion,
    () => -1,
  );
  return useMemo(() => (version < 0 ? [] : listDeviceVaults()), [version]);
}
