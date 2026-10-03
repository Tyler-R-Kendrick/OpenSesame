import {
  type FormRoad,
  type TileRoad,
  connectRoadEpoch,
  connectorActs,
  connectorPagesOpen,
  connectorTile,
  formRoad,
  subscribeConnectRoads,
} from "@opensesame/app-core/lib/connect-roads.js";
import type { Provider } from "@opensesame/app-core/lib/connections.js";
import { useSyncExternalStore } from "react";
import { useVault } from "../lib/vault/hooks.js";

export type ConnectorRoads = {
  /** The connector pages are routed, so a link into one goes somewhere. */
  pages: boolean;
  /** The page has something a person can do here (ADR 0158). */
  acts: (provider: Pick<Provider, "id">) => boolean;
  /** What the provider's tile offers, or null when it is not drawn. */
  tile: (provider: Pick<Provider, "id">) => TileRoad | null;
  /** The road a key, configuration or authorize form saves through. */
  form: (provider: Pick<Provider, "id" | "authKind">) => FormRoad | null;
};

/**
 * What connectors can do on this device, read again when a road opens or
 * closes: Connections switched on or off (the connector pages are routed
 * only while it is on), a Connect credential sealed or forgotten, a vault
 * unlocked or locked.
 */
export function useConnectorRoads(): ConnectorRoads {
  useSyncExternalStore(
    subscribeConnectRoads,
    connectRoadEpoch,
    connectRoadEpoch,
  );
  const { status, guest, tomb } = useVault();
  const sealedVault = status === "unlocked" && !guest && Boolean(tomb);
  return {
    pages: connectorPagesOpen(),
    acts: (provider) => connectorActs(provider, sealedVault),
    tile: (provider) => connectorTile(provider, sealedVault),
    form: (provider) => formRoad(provider.id, provider.authKind),
  };
}
