/**
 * Device-local connector configuration.
 *
 * An api-key or configuration connector saves on this device when no Host is
 * reachable. The connection record and `publicFields` hold only non-secret
 * values. Secret material stays in a second record and is copied only onto
 * the feature operation (`runFeatureConnector`).
 */

import { ConnectionsError } from "./connections-error.js";
import {
  localGitToConnection,
  mergeLocalGitConnections,
} from "./connections-local-git.js";
import type { Connection, Provider } from "./connections.js";
import { catalogProvider } from "./connector-catalog.js";
import type { GitRemoteConfiguration } from "./git-auth-modes.js";
import { isGitBackupProvider } from "./git-backup-forges.js";
import { rememberLocalGitRemote } from "./git-remote-local.js";
import { isLocalGitRemoteId } from "./git-remote-local.js";
import { bindHistoryConnection } from "./history-backups.js";
import { kvDelete, kvGet, kvSet } from "./kv.js";

const PUBLIC_KEY = "opensesame.device-connectors.v1";
const SECRET_KEY = "opensesame.device-connector-secrets.v1";
const ID_PREFIX = "conn_local_";

type PublicRow = {
  connectionId: string;
  providerId: string;
  displayName: string;
  scopes: string[];
  fields: Record<string, string>;
  createdAt: string;
  updatedAt: string;
};

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

export function connectionCreateJson(body: SaveBody): string {
  return JSON.stringify({
    provider_id: body.providerId,
    ...(body.displayName ? { display_name: body.displayName } : undefined),
    ...(body.scopes ? { scopes: body.scopes } : undefined),
    ...(body.projectId ? { project_id: body.projectId } : undefined),
    ...(body.integrationId
      ? { integration_id: body.integrationId }
      : undefined),
  });
}

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

function readRows(): PublicRow[] {
  const raw = kvGet(PUBLIC_KEY);
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isRow);
  } catch {
    return [];
  }
}

function isRow(value: unknown): value is PublicRow {
  if (!value || typeof value !== "object") return false;
  const row = value as PublicRow;
  return (
    typeof row.connectionId === "string" &&
    typeof row.providerId === "string" &&
    typeof row.displayName === "string" &&
    Array.isArray(row.scopes) &&
    row.fields !== null &&
    typeof row.fields === "object"
  );
}

function writeRows(rows: PublicRow[]): void {
  if (rows.length === 0) kvDelete(PUBLIC_KEY);
  else kvSet(PUBLIC_KEY, JSON.stringify(rows));
}

function readSecretMap(): Record<string, Record<string, string>> {
  const raw = kvGet(SECRET_KEY);
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      return {};
    return parsed as Record<string, Record<string, string>>;
  } catch {
    return {};
  }
}

function writeSecretMap(map: Record<string, Record<string, string>>): void {
  if (Object.keys(map).length === 0) kvDelete(SECRET_KEY);
  else kvSet(SECRET_KEY, JSON.stringify(map));
}

export function forgetDeviceConnectors(): void {
  kvDelete(PUBLIC_KEY);
  kvDelete(SECRET_KEY);
}

function findId(id: string): PublicRow | undefined {
  return readRows().find((row) => row.connectionId === id);
}

function latestFor(providerId: string): PublicRow | undefined {
  return readRows()
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

function upsert(row: PublicRow, secrets: Record<string, string>): void {
  const rows = readRows().filter(
    (item) => item.connectionId !== row.connectionId,
  );
  rows.push(row);
  writeRows(rows);
  const map = readSecretMap();
  if (Object.keys(secrets).length === 0) delete map[row.connectionId];
  else map[row.connectionId] = secrets;
  writeSecretMap(map);
}

export function deviceConnection(id: string): Connection | null {
  const row = findId(id);
  if (!row || isLocalGitRemoteId(id)) return null;
  return toConnection(row);
}

export function listDeviceConnections(): Connection[] {
  return readRows()
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

export function publicConnectorFields(
  connectionId: string,
): Record<string, string> {
  return { ...(findId(connectionId)?.fields ?? {}) };
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
  return toConnection(row);
}

function unreachable(error: unknown): boolean {
  return (
    error instanceof ConnectionsError &&
    (error.code === "unreachable" || error.status === 0)
  );
}

/** Host create when it answers; a device record when it cannot be reached. */
export function createHostOrDevice(
  body: SaveBody,
  host: () => Promise<Connection>,
): Promise<Connection> {
  if (isGitBackupProvider(body.providerId)) return host();
  return host().catch((error: unknown) => {
    if (!unreachable(error)) throw error;
    return createDeviceConnection(body);
  });
}

export function sealDeviceCredential(
  id: string,
  value: string,
): Connection | null {
  const row = findId(id);
  if (!row || isLocalGitRemoteId(id)) return null;
  const secrets = { ...(readSecretMap()[id] ?? {}), credential: value };
  upsert({ ...row, updatedAt: nowIso() }, secrets);
  return toConnection({ ...row, updatedAt: nowIso() });
}

export function sealDeviceConfiguration(
  id: string,
  values: Record<string, string>,
): Connection | null {
  const row = findId(id);
  if (!row) return null;
  const hidden = secretNames(row.providerId);
  const fields = { ...row.fields };
  const secrets = { ...(readSecretMap()[id] ?? {}) };
  for (const [key, value] of Object.entries(values)) {
    if (hidden.has(key)) secrets[key] = value;
    else fields[key] = value;
  }
  const next = { ...row, fields, updatedAt: nowIso() };
  upsert(next, secrets);
  return isLocalGitRemoteId(id) ? null : toConnection(next);
}

export function revokeDeviceConnection(id: string): {
  revoked: boolean;
  providerRevocation: "ok";
} | null {
  if (!findId(id) || isLocalGitRemoteId(id)) return null;
  writeRows(readRows().filter((row) => row.connectionId !== id));
  const map = readSecretMap();
  delete map[id];
  writeSecretMap(map);
  return { revoked: true, providerRevocation: "ok" };
}

function splitValues(
  providerId: string,
  values: Record<string, string>,
): { fields: Record<string, string>; secrets: Record<string, string> } {
  const hidden = secretNames(providerId);
  const fields: Record<string, string> = {};
  const secrets: Record<string, string> = {};
  for (const [key, value] of Object.entries(values)) {
    if (value.trim() === "") continue;
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
  const split = splitValues(
    provider.id,
    input.configuration as unknown as Record<string, string>,
  );
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
  const row = latestFor(provider.id);
  if (!row) return { ok: false, providerId: provider.id };
  const fields = { ...row.fields };
  if (row.scopes.length > 0) fields.scopes = row.scopes.join(" ");
  return {
    ok: true,
    providerId: provider.id,
    operation: provider.operations[0] ?? "configure",
    fields,
    secrets: { ...(readSecretMap()[row.connectionId] ?? {}) },
  };
}
