/** Store-owned transfer notifications; these carry identities, never root keys. */
import { currentRealmGeneration } from "./decoy-session.js";
import type { VaultState } from "./vault/store-state.js";
import { vaultIdentity } from "./vault/store-vault-identity.js";
export type DeviceConnectorPrincipal = Readonly<{
  id: string;
  tomb: string;
  kind: "member" | "guest";
}>;
let guest: { generation: number; tomb: string; id: string } | null = null;
const generations = new WeakMap<DeviceConnectorPrincipal, number>();
function admitted(
  principal: DeviceConnectorPrincipal,
): DeviceConnectorPrincipal {
  generations.set(principal, currentRealmGeneration());
  return principal;
}
export function isCurrentDeviceConnectorPrincipal(
  principal: DeviceConnectorPrincipal,
): boolean {
  return generations.get(principal) === currentRealmGeneration();
}
const transfers = new Set<
  (
    from: DeviceConnectorPrincipal,
    to: DeviceConnectorPrincipal,
  ) => Promise<void>
>();

export function deviceConnectorPrincipalFromState(
  state: VaultState,
): DeviceConnectorPrincipal | null {
  if (state.status !== "unlocked" || state.awaitingSecondStep || !state.header)
    return null;
  if (!state.guest) {
    const identity = vaultIdentity(state.header);
    return identity
      ? admitted({
          id: `${state.tomb}:${identity}`,
          tomb: state.tomb,
          kind: "member",
        })
      : null;
  }
  const generation = currentRealmGeneration();
  if (!guest || guest.generation !== generation || guest.tomb !== state.tomb) {
    guest = {
      generation,
      tomb: state.tomb,
      id: `guest:${crypto.randomUUID()}`,
    };
  }
  return admitted({ id: guest.id, tomb: state.tomb, kind: "guest" });
}

export function onDeviceConnectorPrincipalTransfer(
  callback: (
    from: DeviceConnectorPrincipal,
    to: DeviceConnectorPrincipal,
  ) => Promise<void>,
): void {
  transfers.add(callback);
}

/** Called only by the owning store after the original guest body has committed. */
export async function notifyDeviceConnectorPrincipalTransfer(
  from: DeviceConnectorPrincipal | null,
  state: VaultState,
): Promise<void> {
  const to = deviceConnectorPrincipalFromState(state);
  if (from?.kind !== "guest" || to?.kind !== "member") return;
  for (const callback of transfers) await callback(from, to);
}
