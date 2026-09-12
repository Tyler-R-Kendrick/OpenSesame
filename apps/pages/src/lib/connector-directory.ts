/**
 * The connector directory — connectors already authorized somewhere else,
 * pulled in by reference (ADR 0115).
 *
 * The setup ceremony's connectors tab and Access › Connectors both read and
 * write through here. A directory is a Nango-compatible endpoint the operator
 * names (`lib/nango-directory.ts` does the reading); what comes back is the
 * list a PAM plane binds people and agents to, and never a credential.
 *
 * Three homes, by sensitivity:
 *
 *  - The **endpoint** is configuration and sits in plaintext beside
 *    `setup.v1` (`connector-directory.v1`): the ceremony runs before any vault
 *    exists, and an address is not a secret.
 *  - The **key and the synced list** are sealed in the tomb
 *    (`config/connector-directory`) once one is open — the list names
 *    integrations and end users, which is nobody else's business.
 *  - A sync run **before a vault exists** waits in memory, and the first
 *    unlock seals it (`sealPendingConnectorDirectory`, called from the app
 *    shell). A reload before then forgets the key — the endpoint survives,
 *    and Access › Connectors asks for the key again. Nothing sensitive is
 *    ever written in the clear to get around that.
 */

import {
  type BoundaryValue,
  isJsonObject,
  isNumber,
  isString,
} from "@opensesame/os-domain";
import { kvGet, kvRefresh, kvSetDurable } from "./kv.js";
import { notifyLocalIamChange } from "./local-iam-events.js";
import {
  type DirectoryConnection,
  type DirectoryIntegration,
  type DirectoryListing,
  listDirectory,
  normalizeDirectoryEndpoint,
} from "./nango-directory.js";
import {
  VfsError,
  readFile,
  tombFileKey,
  tombUnlocked,
  writeFile,
} from "./vfs.js";

export const DIRECTORY_KEY = "connector-directory.v1";
export const DIRECTORY_PATH = "config/connector-directory";
const MAX_BYTES = 512_000;

export type ConnectorDirectory = {
  version: 1;
  endpoint: string;
  /** The environment key the sync used; empty where the endpoint needs none. */
  key: string;
  /** ISO 8601 — when the list below was read. */
  syncedAt: string;
  integrations: DirectoryIntegration[];
  connections: DirectoryConnection[];
};

/* ------------------------------------------------------- plaintext endpoint */

export function readDirectoryEndpoint(): string {
  try {
    const raw = kvGet(DIRECTORY_KEY);
    if (!raw) return "";
    const parsed: BoundaryValue = JSON.parse(raw);
    if (!isJsonObject(parsed) || !isString(parsed.endpoint)) return "";
    return normalizeDirectoryEndpoint(parsed.endpoint) ?? "";
  } catch {
    return "";
  }
}

/** Durable: an endpoint typed once during setup has to survive the reload. */
export async function writeDirectoryEndpoint(endpoint: string): Promise<void> {
  const value = normalizeDirectoryEndpoint(endpoint) ?? "";
  await kvSetDurable(DIRECTORY_KEY, JSON.stringify({ endpoint: value }));
}

/* ------------------------------------------------------------ sealed record */

function isIntegration(value: BoundaryValue): value is DirectoryIntegration {
  return (
    isJsonObject(value) &&
    isString(value.id) &&
    isString(value.provider) &&
    isString(value.displayName)
  );
}

function isConnection(value: BoundaryValue): value is DirectoryConnection {
  return (
    isJsonObject(value) &&
    isString(value.id) &&
    isString(value.connectionId) &&
    isString(value.integrationId) &&
    isString(value.provider) &&
    isString(value.displayName) &&
    (value.endUser === null || isString(value.endUser)) &&
    (value.createdAt === null || isString(value.createdAt)) &&
    isNumber(value.errors)
  );
}

function parseRecord(value: BoundaryValue): ConnectorDirectory | null {
  if (
    !isJsonObject(value) ||
    value.version !== 1 ||
    !isString(value.endpoint) ||
    !isString(value.key) ||
    !isString(value.syncedAt) ||
    !Array.isArray(value.integrations) ||
    !Array.isArray(value.connections) ||
    !value.integrations.every(isIntegration) ||
    !value.connections.every(isConnection)
  )
    return null;
  return {
    version: 1,
    endpoint: value.endpoint,
    key: value.key,
    syncedAt: value.syncedAt,
    integrations: value.integrations,
    connections: value.connections,
  };
}

/**
 * The sealed record, or null where none was ever written. Throws
 * `VfsError("locked")` before unlock — a caller that can be asked before the
 * vault is open should check `tombUnlocked` first.
 */
export async function readConnectorDirectory(
  tomb: string,
): Promise<ConnectorDirectory | null> {
  await kvRefresh(tombFileKey(tomb, DIRECTORY_PATH), MAX_BYTES * 2);
  try {
    const bytes = await readFile(tomb, DIRECTORY_PATH);
    if (bytes.length > MAX_BYTES) return null;
    const parsed: BoundaryValue = JSON.parse(new TextDecoder().decode(bytes));
    return parseRecord(parsed);
  } catch (error) {
    if (error instanceof VfsError && error.code === "not-found") return null;
    throw error;
  }
}

async function writeConnectorDirectory(
  tomb: string,
  record: ConnectorDirectory,
): Promise<void> {
  const bytes = new TextEncoder().encode(JSON.stringify(record));
  if (bytes.length > MAX_BYTES) {
    throw new Error("That directory is too large to keep here.");
  }
  try {
    await writeFile(tomb, DIRECTORY_PATH, bytes);
  } finally {
    notifyLocalIamChange();
  }
}

/* ------------------------------------------------ the sync, and its parking */

let pending: ConnectorDirectory | null = null;

/** What a sync left behind before any vault could seal it. */
export function pendingConnectorDirectory(): ConnectorDirectory | null {
  return pending;
}

/** Tests, and a deliberate discard: forget an unsealed sync. */
export function clearPendingConnectorDirectory(): void {
  pending = null;
}

export const connectorDirectorySeams = {
  listDirectory,
  now: () => new Date().toISOString(),
};

/**
 * Read the endpoint and keep what it said. The endpoint is written down
 * either way; the list lands sealed in `tomb` when that tomb is open, and
 * waits in memory otherwise.
 */
export async function syncConnectorDirectory(input: {
  endpoint: string;
  key: string;
  tomb: string | null;
}): Promise<ConnectorDirectory> {
  const endpoint = normalizeDirectoryEndpoint(input.endpoint);
  if (!endpoint) {
    throw new Error("Use an https address, or http on loopback.");
  }
  const listing: DirectoryListing = await connectorDirectorySeams.listDirectory(
    endpoint,
    input.key.trim(),
  );
  const record: ConnectorDirectory = {
    version: 1,
    endpoint,
    key: input.key.trim(),
    syncedAt: connectorDirectorySeams.now(),
    integrations: listing.integrations,
    connections: listing.connections,
  };
  await writeDirectoryEndpoint(endpoint);
  if (input.tomb && tombUnlocked(input.tomb)) {
    await writeConnectorDirectory(input.tomb, record);
    pending = null;
  } else {
    pending = record;
  }
  return record;
}

/**
 * Seal a sync that ran before the vault existed. Called once the store
 * reports `unlocked`; a no-op with nothing pending. Says whether it wrote.
 */
export async function sealPendingConnectorDirectory(
  tomb: string,
  { ephemeral = false }: { ephemeral?: boolean } = {},
): Promise<boolean> {
  if (!pending || !tombUnlocked(tomb)) return false;
  await writeConnectorDirectory(tomb, pending);
  // A guest tomb is wiped on lock: it gets the list for its session, and the
  // sync keeps waiting for a vault that lasts.
  if (!ephemeral) pending = null;
  return true;
}

/* ---------------------------------------------------- naming for the PAM plane */

/** FNV-1a over a string: eight hex characters, the same every time. */
function digest(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/**
 * The share-grant resource id for a directory connection — stable across
 * syncs, and never longer than the ledger admits. When the human-readable
 * pair would not fit, a digest of it stands in: Nango's numeric id alone is
 * blank on older servers, and two connections sharing one id would share
 * their bindings.
 */
export function connectorResourceId(connection: DirectoryConnection): string {
  const readable = `nango:${connection.integrationId}/${connection.connectionId}`;
  if (readable.length <= 128) return readable;
  return `nango:${connection.integrationId.slice(0, 100)}#${digest(readable)}`;
}

export function connectorResourceLabel(
  connection: DirectoryConnection,
): string {
  const who = connection.endUser ? ` · ${connection.endUser}` : "";
  return `${connection.displayName}${who}`.slice(0, 128);
}

/** "api.nango.dev" — the endpoint as a row says it, scheme dropped. */
export function directoryOriginLabel(endpoint: string): string {
  return endpoint.replace(/^https?:\/\//, "");
}
