import {
  browserGrantEpoch,
  subscribeBrowserGrant,
} from "@opensesame/app-core/lib/browser-pairing.js";
import {
  type FormRoad,
  connectRoadEpoch,
  connectorActs,
  formRoad,
  subscribeConnectRoads,
} from "@opensesame/app-core/lib/connect-roads.js";
import type { Provider } from "@opensesame/app-core/lib/connections.js";
import { useSyncExternalStore } from "react";
import { useSettingsEpoch } from "../lib/use-settings.js";
import { useVault } from "../lib/vault/hooks.js";
import { useComposition } from "./capabilities.js";

export type ConnectorRoads = {
  /** The page has something a person can do here (ADR 0158). */
  acts: (provider: Pick<Provider, "id">) => boolean;
  /** The road a key, configuration or authorize form saves through. */
  form: (provider: Pick<Provider, "id" | "authKind">) => FormRoad | null;
};

/**
 * What connectors can do on this device, read again when a road opens or
 * closes: the Host named in settings, the Host grant approved, renewed, ended
 * or lapsed, a Connect credential sealed or forgotten, a vault unlocked or
 * locked.
 */
export function useConnectorRoads(): ConnectorRoads {
  useSettingsEpoch();
  useSyncExternalStore(
    subscribeConnectRoads,
    connectRoadEpoch,
    connectRoadEpoch,
  );
  useSyncExternalStore(
    subscribeBrowserGrant,
    browserGrantEpoch,
    browserGrantEpoch,
  );
  const { status, guest, tomb } = useVault();
  const sealedVault = status === "unlocked" && !guest && Boolean(tomb);
  return {
    acts: (provider) => connectorActs(provider, sealedVault),
    form: (provider) => formRoad(provider.id, provider.authKind),
  };
}

/**
 * Which connectors Settings › Capabilities draws a tile for: the page has
 * something to do here (`acts`) and the page exists. The connector pages are
 * the Connections capability's routes (ADR 0153), absent until it is running,
 * so a tile before that is a link to a blank page.
 */
export function useConnectorTiles(): (
  provider: Pick<Provider, "id">,
) => boolean {
  const { acts } = useConnectorRoads();
  const pages = useComposition().lifecycle["connectors.external"] === "active";
  return (provider) => pages && acts(provider);
}
