import {
  type FormRoad,
  connectorActs,
  formRoad,
} from "@opensesame/app-core/lib/connect-roads.js";
import type { Provider } from "@opensesame/app-core/lib/connections.js";
import { useSettingsEpoch } from "../lib/use-settings.js";
import { useVault } from "../lib/vault/hooks.js";
import { useVercelConnectConfigured } from "./vercel-connect.js";

export type ConnectorRoads = {
  /** The page has something a person can do here (ADR 0150). */
  acts: (provider: Pick<Provider, "id">) => boolean;
  /** The road a key, configuration or authorize form saves through. */
  form: (provider: Pick<Provider, "id" | "authKind">) => FormRoad | null;
};

/**
 * What connectors can do on this device, read again when a road opens or
 * closes: the Host named in settings, a Connect credential sealed or
 * forgotten, a vault unlocked or locked.
 */
export function useConnectorRoads(): ConnectorRoads {
  useSettingsEpoch();
  useVercelConnectConfigured();
  const { status, guest, tomb } = useVault();
  const sealedVault = status === "unlocked" && !guest && Boolean(tomb);
  return {
    acts: (provider) => connectorActs(provider, sealedVault),
    form: (provider) => formRoad(provider.id, provider.authKind),
  };
}
