/** Connector ownership follows an admitted vault, never the device's KV key. */
import { isRealAuthorityBlocked } from "./decoy-session.js";
import {
  type DeviceConnectorPrincipal,
  deviceConnectorPrincipalFromState,
  isCurrentDeviceConnectorPrincipal,
} from "./device-connector-principal-state.js";
import { vaultStore } from "./vault/store.js";
export type { DeviceConnectorPrincipal } from "./device-connector-principal-state.js";

export function activeDeviceConnectorPrincipal(): DeviceConnectorPrincipal | null {
  if (isRealAuthorityBlocked()) return null;
  return deviceConnectorPrincipalFromState(vaultStore.getSnapshot());
}

export function requireDeviceConnectorPrincipal(): DeviceConnectorPrincipal {
  const principal = activeDeviceConnectorPrincipal();
  if (!principal)
    throw new Error("Unlock this vault to manage its connectors.");
  return principal;
}

export function assertDeviceConnectorPrincipal(
  original: DeviceConnectorPrincipal,
): void {
  const current = requireDeviceConnectorPrincipal();
  if (
    !isCurrentDeviceConnectorPrincipal(original) ||
    current.id !== original.id ||
    current.tomb !== original.tomb
  )
    throw new Error("The connector's vault session changed.");
}
