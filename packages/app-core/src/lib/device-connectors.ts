/**
 * Device-local connector configuration.
 *
 * An api-key or configuration connector saves on this device (Pages speaks no
 * Host, ADR 0128). The connection record and `publicFields` hold only non-secret
 * values. Secret material stays in an owner-vault item and is copied only onto
 * the feature operation (`runFeatureConnector`).
 */

import {
  localGitToConnection,
  mergeLocalGitConnections,
} from "./connections-local-git.js";
import type { Connection, Provider } from "./connections.js";
import { catalogProvider } from "./connector-catalog.js";
import { assertNotDecoySession } from "./decoy-session.js";
import {
  assertDeviceConnectorPrincipal,
  requireDeviceConnectorPrincipal,
} from "./device-connector-principal.js";
import {
  type PublicRow,
  type StringFields,
  clearDeviceConnectorStore,
  mutateDeviceRows,
  readDeviceRows,
  readDeviceSecrets,
  removeDeviceConnectorRecords,
  writeDeviceSecrets,
} from "./device-connector-records.js";
import type { GitRemoteConfiguration } from "./git-auth-modes.js";
import { isGitBackupProvider } from "./git-backup-forges.js";
import {
  isLocalGitRemoteId,
  rememberLocalGitRemote,
} from "./git-remote-local.js";
import { bindHistoryConnection } from "./history-backups.js";

const ID_PREFIX = "conn_local_";

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

export function forgetDeviceConnectors(): Promise<void> {
  return clearDeviceConnectorStore();
}

function findId(id: string): PublicRow | undefined {
  return readDeviceRows().find((row) => row.connectionId === id);
}

function latestFor(providerId: string): PublicRow | undefined {
  return readDeviceRows()
    .filter((row) => row.providerId === providerId)
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

function toConnection(row: PublicRow): Connection {
  return {
    connectionId: row.connectionId,
    connectionRef: `local/connector/${row.connectionId}`,
    logicalName: row.connectionId,
    displayName: row.displayName,
    providerId: row.providerId,
    integrationId: null,
    status: "active",
    statusDetail: null,
    organizationId: "local",
    projectId: null,
    ownerKind: "user",
    shareability: "private",
    requestedScopes: row.scopes,
    grantedScopes: row.scopes,
    accountLabel: null,
    expiresAt: null,
    refreshable: false,
    lastRefreshedAt: null,
    maxInvokeLevel: 0,
    egress: { scheme: "none", authorities: [], pathPrefixes: [] },
    bindings: [],
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function upsert(row: PublicRow, secrets: StringFields): Promise<void> {
  const principal = requireDeviceConnectorPrincipal();
  await mutateDeviceRows((rows) =>
    rows.map((current) =>
      current.connectionId === row.connectionId
        ? {
            ...current,
            fields: { ...current.fields, ...row.fields },
            updatedAt: row.updatedAt,
          }
        : current,
    ),
  );
  assertDeviceConnectorPrincipal(principal);
  await writeDeviceSecrets({ [row.connectionId]: secrets });
  assertDeviceConnectorPrincipal(principal);
}

export function deviceConnection(id: string): Connection | null {
  assertNotDecoySession();
  const row = findId(id);
  if (!row || isLocalGitRemoteId(id)) return null;
  return toConnection(row);
}

export function listDeviceConnections(): Connection[] {
  return readDeviceRows()
    .filter((row) => !isLocalGitRemoteId(row.connectionId))
    .map(toConnection);
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

export function createDeviceConnection(body: SaveBody): Promise<Connection> {
  assertNotDecoySession();
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
  return mutateDeviceRows((rows) => [...rows, row]).then(() =>
    toConnection(row),
  );
}

export async function sealDeviceCredential(
  id: string,
  value: string,
): Promise<Connection | null> {
  assertNotDecoySession();
  const principal = requireDeviceConnectorPrincipal();
  const row = findId(id);
  if (!row || isLocalGitRemoteId(id)) return null;
  const secrets: StringFields = { ...(readDeviceSecrets()[id] ?? {}) };
  secrets.credential = value;
  await upsert({ ...row, updatedAt: nowIso() }, secrets);
  assertDeviceConnectorPrincipal(principal);
  return toConnection({ ...row, updatedAt: nowIso() });
}

export async function sealDeviceConfiguration(
  id: string,
  values: Record<string, string>,
): Promise<Connection | null> {
  assertNotDecoySession();
  const principal = requireDeviceConnectorPrincipal();
  const row = findId(id);
  if (!row) return null;
  const hidden = secretNames(row.providerId);
  const fields: StringFields = { ...row.fields };
  const secrets: StringFields = { ...(readDeviceSecrets()[id] ?? {}) };
  for (const [key, value] of Object.entries(values)) {
    if (hidden.has(key)) secrets[key] = value;
    else fields[key] = value;
  }
  const next = { ...row, fields, updatedAt: nowIso() };
  await upsert(next, secrets);
  assertDeviceConnectorPrincipal(principal);
  return isLocalGitRemoteId(id) ? null : toConnection(next);
}

export function revokeDeviceConnection(id: string): Promise<{
  revoked: boolean;
  providerRevocation: "ok";
}> | null {
  assertNotDecoySession();
  if (!findId(id) || isLocalGitRemoteId(id)) return null;
  return removeDeviceConnectorRecords([id]).then(() => ({
    revoked: true,
    providerRevocation: "ok",
  }));
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
  const realm = assertNotDecoySession();
  const principal = requireDeviceConnectorPrincipal();
  const displayName = input.displayName.trim() || provider.displayName;
  const remote = await rememberLocalGitRemote({
    displayName,
    configuration: input.configuration,
  });
  assertNotDecoySession(realm);
  assertDeviceConnectorPrincipal(principal);
  bindHistoryConnection(provider.id, remote.id, input.configuration.remote_url);
  const split = splitValues(provider.id, input.configuration);
  const stamp = nowIso();
  const row: PublicRow = {
    connectionId: remote.id,
    providerId: provider.id,
    displayName,
    scopes: [],
    fields: split.fields,
    createdAt: stamp,
    updatedAt: stamp,
  };
  await mutateDeviceRows((rows) => [...rows, row]);
  assertNotDecoySession(realm);
  assertDeviceConnectorPrincipal(principal);
  await upsert(row, split.secrets);
  assertNotDecoySession(realm);
  assertDeviceConnectorPrincipal(principal);
  return localGitToConnection(remote);
}

/** The catalog operation the owning feature runs from the saved configuration. */
export function runFeatureConnector(provider: Provider): ConnectorRun {
  assertNotDecoySession();
  const row = latestFor(provider.id);
  if (!row) return { ok: false, providerId: provider.id };
  const fields: StringFields = { ...row.fields };
  if (row.scopes.length > 0) fields.scopes = row.scopes.join(" ");
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
