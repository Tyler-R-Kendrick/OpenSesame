/** Only metadata and vault-item references live in the connector ledger. */
import { canonicalize } from "@opensesame/os-domain";
import { z } from "zod";
import {
  DEVICE_CONNECTOR_KEYS,
  readDeviceRows,
  removeDeviceConfigurationDurable,
} from "../device-connector-records.js";
import { saveDeviceConnectorConfigurationDurable } from "../device-connectors.js";
import { kvHydrate } from "../kv.js";
import {
  assertVaultCredentials,
  discardVaultCredentials,
  initializeVaultCredentialCustody,
  readVaultCredentials,
  stageVaultCredentials,
} from "../vault-credential-custody.js";
import {
  type TailscaleApp,
  type TailscaleAppConfiguration,
  parseTailscaleApp,
} from "./oauth-app.js";

const FIELD = "tailscale_oauth_app";
const MetadataSchema = z
  .object({
    apiBase: z.string().url(),
    tailnet: z.string(),
    redirectUri: z.string().url(),
    name: z.string(),
    id: z.string(),
    redirectURIs: z.array(z.string().url()),
    scopes: z.array(z.string()),
    allowedNodeAttributes: z.array(z.string()).optional(),
    credentialReference: z.string(),
    vaultTomb: z.string(),
  })
  .strict();
export type SavedTailscaleApp = z.infer<typeof MetadataSchema> & {
  connectionId: string;
};
function binding(config: TailscaleAppConfiguration, id: string): string {
  return canonicalize({
    providerId: "tailscale",
    apiBase: config.apiBase,
    tailnet: config.tailnet,
    redirectUri: config.redirectUri,
    clientId: id,
    allowedNodeAttributes: config.allowedNodeAttributes ?? [],
  });
}
export async function hydrateTailscaleApps(): Promise<void> {
  await initializeVaultCredentialCustody();
  await kvHydrate([...DEVICE_CONNECTOR_KEYS]);
}
export function readTailscaleApp(
  connectionId?: string,
): SavedTailscaleApp | null {
  const row = readDeviceRows().find(
    (entry) =>
      entry.providerId === "tailscale" &&
      (!connectionId || entry.connectionId === connectionId) &&
      entry.fields[FIELD],
  );
  if (!row) return null;
  try {
    return {
      ...MetadataSchema.parse(JSON.parse(row.fields[FIELD] ?? "")),
      connectionId: row.connectionId,
    };
  } catch {
    return null;
  }
}
export function openTailscaleApp(
  saved: SavedTailscaleApp,
  tomb: string,
): TailscaleApp {
  if (saved.vaultTomb !== tomb)
    throw new Error("Open the vault that owns this Tailscale app.");
  const credentials = readVaultCredentials(
    saved.credentialReference,
    binding(saved, saved.id),
    ["clientSecret"],
    tomb,
  );
  const clientSecret = credentials.fields.get("clientSecret");
  if (!clientSecret)
    throw new Error("The Tailscale app credential is unavailable.");
  return {
    id: saved.id,
    name: saved.name,
    clientSecret,
    redirectURIs: saved.redirectURIs,
    scopes: saved.scopes,
    ...(saved.allowedNodeAttributes
      ? { allowedNodeAttributes: saved.allowedNodeAttributes }
      : {}),
  };
}
export async function saveTailscaleApp(
  config: TailscaleAppConfiguration,
  app: TailscaleApp,
  tomb: string,
  check: () => void,
): Promise<SavedTailscaleApp> {
  parseTailscaleApp(app, config);
  check();
  const capture = await stageVaultCredentials(
    {
      name: app.name,
      targetBinding: binding(config, app.id),
      fields: [
        {
          field: "clientSecret",
          label: "Tailscale OAuth app secret",
          value: app.clientSecret,
        },
      ],
    },
    tomb,
    check,
  );
  const metadata = {
    ...config,
    id: app.id,
    name: app.name,
    redirectURIs: app.redirectURIs,
    scopes: app.scopes,
    credentialReference: capture.reference,
    vaultTomb: tomb,
  };
  let published = false;
  try {
    const connection = await saveDeviceConnectorConfigurationDurable(
      () => {
        check();
        return {
          providerId: "tailscale",
          displayName: app.name,
          scopes: app.scopes,
          fields: {
            [FIELD]: JSON.stringify(metadata),
            self_hosted_configuration: "tailscale-oauth-v1",
          },
          secrets: {},
        };
      },
      undefined,
      () => assertVaultCredentials(capture, tomb, check),
    );
    published = true;
    check();
    return { ...metadata, connectionId: connection.connectionId };
  } catch (error) {
    if (!published)
      await discardVaultCredentials(capture, tomb, check).catch(
        () => undefined,
      );
    throw error;
  }
}
export async function forgetTailscaleApp(
  saved: SavedTailscaleApp,
  tomb: string,
  check: () => void,
): Promise<void> {
  check();
  if (saved.vaultTomb !== tomb)
    throw new Error("Open the vault that owns this Tailscale app.");
  const capture = readVaultCredentials(
    saved.credentialReference,
    binding(saved, saved.id),
    ["clientSecret"],
    tomb,
  );
  await removeDeviceConfigurationDurable(
    saved.connectionId,
    () => {
      check();
      const current = readTailscaleApp(saved.connectionId);
      if (!current || canonicalize(current) !== canonicalize(saved))
        throw new Error("The Tailscale configuration changed; reload it.");
    },
    check,
  );
  await discardVaultCredentials(capture, tomb, check);
}

export function assertTailscaleAppCurrent(saved: SavedTailscaleApp): void {
  const current = readTailscaleApp(saved.connectionId);
  if (!current || canonicalize(current) !== canonicalize(saved))
    throw new Error("The Tailscale configuration changed; reload it.");
}
