/**
 * Device-local connector configuration.
 *
 * An api-key or configuration connector saves on this device (Pages speaks no
 * Host, ADR 0128). The connection record and `publicFields` hold only non-secret
 * values. Secret material stays in a second record and is copied only onto
 * the feature operation (`runFeatureConnector`).
 */

import {
  localGitToConnection,
  mergeLocalGitConnections,
} from "./connections-local-git.js";
import type { Connection, Provider } from "./connections.js";
import { catalogProvider } from "./connector-catalog.js";
import {
  type PublicRow,
  type StringFields,
  clearDeviceConnectorStore,
  readDeviceRows,
  readDeviceSecrets,
  removeDeviceConfigurationDurable,
  writeDeviceConfigurationDurable,
  writeDeviceRows,
  writeDeviceSecrets,
} from "./device-connector-records.js";
import { deviceConnectorView } from "./device-connector-view.js";
import type { GitRemoteConfiguration } from "./git-auth-modes.js";
import { isGitBackupProvider } from "./git-backup-forges.js";
import {
  isLocalGitRemoteId,
  rememberLocalGitRemote,
} from "./git-remote-local.js";
import { bindHistoryConnection } from "./history-backups.js";

const ID_PREFIX = "conn_local_";
export const deviceProviderRevokers: Record<
  string,
  ((id: string) => Promise<void>) | undefined
> = {};

export type RenderedConnector = {
  connection: Connection;
  publicFields: Record<string, string>;
};

export type ConnectorRun =
  | {
      ok: true;
      providerId: string;
      operation: string;
      fields: Record<string, string>;
      secrets: Record<string, string>;
    }
  | { ok: false; providerId: string };

type SaveBody = {
  providerId: string;
  displayName?: string;
  scopes?: string[];
  projectId?: string;
  integrationId?: string;
};

function nowIso(): string {
  return new Date().toISOString();
}

function randomId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  return `${ID_PREFIX}${[...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

export function isDeviceConnectorId(id: string): boolean {
  return id.startsWith(ID_PREFIX);
}

export function forgetDeviceConnectors(): void {
  clearDeviceConnectorStore();
}

function findId(id: string): PublicRow | undefined {
  return readDeviceRows().find((row) => row.connectionId === id);
}

function latestNativeFor(providerId: string): PublicRow | undefined {
  return readDeviceRows()
    .filter(
      (row) =>
        row.providerId === providerId &&
        (row.fields.self_hosted_configuration === undefined ||
          (row.providerId === "linear" && row.fields.linear_verified === "1")),
    )
    .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))
    .at(-1);
}

const GIT_SECRET_KEYS = [
  "token",
  "password",
  "ssh_private_key",
  "ssh_passphrase",
];

function secretNames(providerId: string): Set<string> {
  const fields = catalogProvider(providerId)?.configurationFields ?? [];
  const names = new Set(
    fields.filter((field) => field.secret).map((field) => field.name),
  );
  if (isGitBackupProvider(providerId)) {
    for (const key of GIT_SECRET_KEYS) names.add(key);
  }
  return names;
}

function upsert(row: PublicRow, secrets: StringFields): void {
  if (row.fields.self_hosted_configuration !== undefined) {
    throw new Error("Self-hosted configuration requires an awaited save");
  }
  const rows = readDeviceRows().filter(
    (item) => item.connectionId !== row.connectionId,
  );
  rows.push(row);
  writeDeviceRows(rows);
  const map = readDeviceSecrets();
  if (Object.keys(secrets).length === 0) delete map[row.connectionId];
  else map[row.connectionId] = secrets;
  writeDeviceSecrets(map);
}

export function deviceConnection(id: string): Connection | null {
  const row = findId(id);
  if (!row || isLocalGitRemoteId(id)) return null;
  return deviceConnectorView(row);
}

export function listDeviceConnections(): Connection[] {
  return readDeviceRows()
    .filter((row) => !isLocalGitRemoteId(row.connectionId))
    .map(deviceConnectorView);
}

export function mergeOfflineConnections(rows: Connection[]): Connection[] {
  const withGit = mergeLocalGitConnections(rows);
  const local = listDeviceConnections();
  if (local.length === 0) return withGit;
  const seen = new Set(withGit.map((row) => row.connectionId));
  return [...withGit, ...local.filter((row) => !seen.has(row.connectionId))];
}

export function publicConnectorFields(connectionId: string): StringFields {
  const fields: StringFields = {};
  for (const [name, value] of Object.entries(
    findId(connectionId)?.fields ?? {},
  )) {
    fields[name] = value;
  }
  return fields;
}

export function renderedConnectorRecord(
  connection: Connection,
): RenderedConnector {
  return {
    connection,
    publicFields: publicConnectorFields(connection.connectionId),
  };
}

export function createDeviceConnection(body: SaveBody): Connection {
  const stamp = nowIso();
  const row: PublicRow = {
    connectionId: randomId(),
    providerId: body.providerId,
    displayName: body.displayName?.trim() || body.providerId,
    scopes: body.scopes ?? [],
    fields: {},
    createdAt: stamp,
    updatedAt: stamp,
  };
  upsert(row, {});
  return deviceConnectorView(row);
}

export type DeviceConnectorConfiguration = {
  providerId: string;
  displayName: string;
  scopes: string[];
  fields: StringFields;
  secrets: StringFields;
};

function configurationRow(
  input: DeviceConnectorConfiguration,
  existingId?: string,
): PublicRow {
  const previous = existingId ? findId(existingId) : undefined;
  if (existingId && (!previous || isLocalGitRemoteId(existingId))) {
    throw new Error("Saved connector not found on this device");
  }
  if (previous && previous.providerId !== input.providerId) {
    throw new Error("A saved connector cannot change its provider");
  }
  const stamp = nowIso();
  return {
    connectionId: previous?.connectionId ?? randomId(),
    providerId: input.providerId,
    displayName: input.displayName,
    scopes: input.scopes,
    fields: input.fields,
    createdAt: previous?.createdAt ?? stamp,
    updatedAt: stamp,
  };
}

/** Wait for encrypted storage before reporting that a configuration was saved. */
export async function saveDeviceConnectorConfigurationDurable(
  makeInput: () => DeviceConnectorConfiguration,
  existingId?: string,
): Promise<Connection> {
  const row = await writeDeviceConfigurationDurable(() => {
    const input = makeInput();
    return { row: configurationRow(input, existingId), secrets: input.secrets };
  });
  return deviceConnectorView(row);
}

export function sealDeviceCredential(
  id: string,
  value: string,
): Connection | null {
  const row = findId(id);
  if (
    !row ||
    isLocalGitRemoteId(id) ||
    row.fields.self_hosted_configuration !== undefined
  )
    return null;
  const secrets: StringFields = { ...(readDeviceSecrets()[id] ?? {}) };
  secrets.credential = value;
  upsert({ ...row, updatedAt: nowIso() }, secrets);
  return deviceConnectorView({ ...row, updatedAt: nowIso() });
}

export function sealDeviceConfiguration(
  id: string,
  values: Record<string, string>,
): Connection | null {
  const row = findId(id);
  if (!row || row.fields.self_hosted_configuration !== undefined) return null;
  const hidden = secretNames(row.providerId);
  const fields: StringFields = { ...row.fields };
  const secrets: StringFields = { ...(readDeviceSecrets()[id] ?? {}) };
  for (const [key, value] of Object.entries(values)) {
    if (hidden.has(key)) secrets[key] = value;
    else fields[key] = value;
  }
  const next = { ...row, fields, updatedAt: nowIso() };
  upsert(next, secrets);
  return isLocalGitRemoteId(id) ? null : deviceConnectorView(next);
}

export async function revokeDeviceConnection(id: string): Promise<{
  revoked: boolean;
  providerRevocation: "ok";
} | null> {
  const row = findId(id);
  if (!row || isLocalGitRemoteId(id)) return null;
  if (
    row.providerId === "linear" &&
    row.fields.linear_authorization !== undefined
  ) {
    const revoke = deviceProviderRevokers.linear;
    if (!revoke)
      throw new Error("Enable External connectors to disconnect Linear");
    await revoke(id);
    return { revoked: true, providerRevocation: "ok" };
  }
  if (row.fields.self_hosted_configuration !== undefined) {
    const removed = await removeDeviceConfigurationDurable(id);
    return removed ? { revoked: true, providerRevocation: "ok" } : null;
  }
  writeDeviceRows(readDeviceRows().filter((row) => row.connectionId !== id));
  const map = readDeviceSecrets();
  delete map[id];
  writeDeviceSecrets(map);
  return { revoked: true, providerRevocation: "ok" };
}

interface SplitFields {
  readonly fields: StringFields;
  readonly secrets: StringFields;
}

function splitValues(
  providerId: string,
  values: GitRemoteConfiguration,
): SplitFields {
  const hidden = secretNames(providerId);
  const fields: StringFields = {};
  const secrets: StringFields = {};
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined || value.trim() === "") continue;
    if (hidden.has(key)) secrets[key] = value;
    else fields[key] = value;
  }
  return { fields, secrets };
}

/** Forge remotes stay on the git road; their catalog fields feed the same operation. */
export async function saveForgeConnector(
  provider: Provider,
  input: { displayName: string; configuration: GitRemoteConfiguration },
): Promise<Connection> {
  const displayName = input.displayName.trim() || provider.displayName;
  const remote = await rememberLocalGitRemote({
    displayName,
    configuration: input.configuration,
  });
  bindHistoryConnection(provider.id, remote.id, input.configuration.remote_url);
  const split = splitValues(provider.id, input.configuration);
  const stamp = nowIso();
  upsert(
    {
      connectionId: remote.id,
      providerId: provider.id,
      displayName,
      scopes: [],
      fields: split.fields,
      createdAt: stamp,
      updatedAt: stamp,
    },
    split.secrets,
  );
  return localGitToConnection(remote);
}

/** The catalog operation the owning feature runs from the saved configuration. */
export function runFeatureConnector(provider: Provider): ConnectorRun {
  const row = latestNativeFor(provider.id);
  if (!row) {
    return { ok: false, providerId: provider.id };
  }
  const fields: StringFields = { ...row.fields };
  if (row.scopes.length > 0) fields.scopes = row.scopes.join(" ");
  // Linear operations are awaited by their provider driver; generic sends must refuse.
  if (
    row.providerId === "linear" &&
    row.fields.linear_authorization !== undefined
  )
    return { ok: false, providerId: provider.id };
  const secrets: StringFields = {
    ...(readDeviceSecrets()[row.connectionId] ?? {}),
  };
  return {
    ok: true,
    providerId: provider.id,
    operation: provider.operations[0] ?? "configure",
    fields,
    secrets,
  };
}
