/**
 * Legacy device rows and secrets, with an atomic ledger for self-hosted
 * configuration. Public readers expose only metadata; private credentials
 * never ride on the connection the page renders.
 */

import {
  type BoundaryValue,
  isJsonObject,
  isString,
} from "@opensesame/os-domain";
import { lockManager } from "../ports.js";
import { atRestReady } from "./at-rest/key.js";
import {
  kvDelete,
  kvDurability,
  kvFlush,
  kvGet,
  kvRefresh,
  kvSet,
  kvSetDurable,
} from "./kv.js";

const PUBLIC_KEY = "opensesame.device-connectors.v1";
const SECRET_KEY = "opensesame.device-connector-secrets.v1";
const ATOMIC_KEY = "opensesame.self-hosted-connectors.v1";
const MAX_RECORD_BYTES = 32 * 1024 * 1024;

/** Hydrate legacy records and the atomic ledger before rendering connections. */
export const DEVICE_CONNECTOR_KEYS = [
  PUBLIC_KEY,
  SECRET_KEY,
  ATOMIC_KEY,
] as const;

export interface StringFields {
  [key: string]: string;
}

export interface PublicRow {
  connectionId: string;
  providerId: string;
  displayName: string;
  scopes: string[];
  fields: StringFields;
  createdAt: string;
  updatedAt: string;
}

interface SecretStore {
  [key: string]: StringFields;
}

export function clearDeviceConnectorStore(): void {
  kvDelete(PUBLIC_KEY);
  kvDelete(SECRET_KEY);
  kvDelete(ATOMIC_KEY);
}

function rowFrom(value: BoundaryValue): PublicRow | null {
  if (!isJsonObject(value)) return null;
  if (
    !isString(value.connectionId) ||
    !isString(value.providerId) ||
    !isString(value.displayName) ||
    !isString(value.createdAt) ||
    !isString(value.updatedAt) ||
    !Array.isArray(value.scopes) ||
    !isJsonObject(value.fields)
  ) {
    return null;
  }
  const scopes: string[] = [];
  for (const scope of value.scopes) {
    if (!isString(scope)) return null;
    scopes.push(scope);
  }
  const fields: StringFields = {};
  for (const [name, entry] of Object.entries(value.fields)) {
    if (!isString(entry)) return null;
    fields[name] = entry;
  }
  return {
    connectionId: value.connectionId,
    providerId: value.providerId,
    displayName: value.displayName,
    scopes,
    fields,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

type Configuration = { row: PublicRow; secrets: StringFields };
interface AtomicStore {
  [connectionId: string]: Configuration | null;
}

function secretFields(value: BoundaryValue): StringFields | null {
  if (!isJsonObject(value)) return null;
  const fields: StringFields = {};
  for (const [name, entry] of Object.entries(value)) {
    if (isString(entry)) fields[name] = entry;
  }
  return fields;
}

function readAtomic(): AtomicStore {
  try {
    const raw = kvGet(ATOMIC_KEY);
    if (!raw) return {};
    const parsed: BoundaryValue = JSON.parse(raw);
    if (!isJsonObject(parsed)) return {};
    const records: AtomicStore = {};
    for (const [id, value] of Object.entries(parsed)) {
      if (value === null) records[id] = null;
      else if (isJsonObject(value)) {
        const row = rowFrom(value.row);
        const secrets = secretFields(value.secrets);
        if (row?.connectionId === id && secrets) records[id] = { row, secrets };
      }
    }
    return records;
  } catch {
    return {};
  }
}

function readLegacyRows(): PublicRow[] {
  const raw = kvGet(PUBLIC_KEY);
  if (!raw) return [];
  try {
    const parsed: BoundaryValue = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const rows: PublicRow[] = [];
    for (const entry of parsed) {
      const row = rowFrom(entry);
      if (row) rows.push(row);
    }
    return rows;
  } catch {
    return [];
  }
}

/** Public readers never include the private half of an atomic configuration. */
export function readDeviceRows(): PublicRow[] {
  const atomic = readAtomic();
  const rows = readLegacyRows().filter((row) => !(row.connectionId in atomic));
  for (const entry of Object.values(atomic)) {
    if (entry) rows.push(entry.row);
  }
  return rows;
}

export function writeDeviceRows(rows: PublicRow[]): void {
  const atomic = readAtomic();
  const legacy = rows.filter((row) => !(row.connectionId in atomic));
  if (legacy.length === 0) kvDelete(PUBLIC_KEY);
  else kvSet(PUBLIC_KEY, JSON.stringify(legacy));
}

function readLegacySecrets(): SecretStore {
  const raw = kvGet(SECRET_KEY);
  if (!raw) return {};
  try {
    const parsed: BoundaryValue = JSON.parse(raw);
    if (!isJsonObject(parsed)) return {};
    const map: SecretStore = {};
    for (const [id, entry] of Object.entries(parsed)) {
      const secrets = secretFields(entry);
      if (secrets) map[id] = secrets;
    }
    return map;
  } catch {
    return {};
  }
}

export function readDeviceSecrets(): SecretStore {
  const map = readLegacySecrets();
  for (const [id, entry] of Object.entries(readAtomic())) {
    if (entry && Object.keys(entry.secrets).length > 0) map[id] = entry.secrets;
    else delete map[id];
  }
  return map;
}

export function writeDeviceSecrets(map: SecretStore): void {
  const atomic = readAtomic();
  const legacy: SecretStore = {};
  for (const [id, secrets] of Object.entries(map)) {
    if (!(id in atomic)) legacy[id] = secrets;
  }
  if (Object.keys(legacy).length === 0) kvDelete(SECRET_KEY);
  else kvSet(SECRET_KEY, JSON.stringify(legacy));
}

let writes: Promise<unknown> = Promise.resolve();

function withConfigurationLock<T>(action: () => Promise<T>): Promise<T> {
  const run = writes.then(async () => {
    await kvFlush();
    await atRestReady();
    const refresh = async () => {
      if (kvDurability() !== "memory") {
        await Promise.all(
          DEVICE_CONNECTOR_KEYS.map((key) => kvRefresh(key, MAX_RECORD_BYTES)),
        );
      }
      if (!locks && kvDurability() === "persistent")
        throw new Error(
          "Web Locks are required to save shared connector configuration.",
        );
      return action();
    };
    const locks = lockManager();
    if (locks) return locks.request("opensesame:device-connectors", refresh);
    return refresh();
  });
  writes = run.catch(() => undefined);
  return run;
}

async function commitAtomic(records: AtomicStore): Promise<void> {
  const value = JSON.stringify(records);
  if (new TextEncoder().encode(value).length > MAX_RECORD_BYTES) {
    throw new Error("Connector configuration exceeds the storage size limit");
  }
  await kvSetDurable(ATOMIC_KEY, value);
}

/** Evaluate compatibility under the lock, then commit metadata and secrets in one sealed file. */
export function writeDeviceConfigurationDurable(
  make: () => Configuration,
): Promise<PublicRow> {
  return withConfigurationLock(async () => {
    const { row, secrets } = make();
    await commitAtomic({
      ...readAtomic(),
      [row.connectionId]: { row, secrets },
    });
    return row;
  });
}

/** A durable tombstone masks legacy copies even if the browser closes immediately. */
export function removeDeviceConfigurationDurable(id: string): Promise<boolean> {
  return withConfigurationLock(async () => {
    const row = readDeviceRows().find((entry) => entry.connectionId === id);
    if (!row || row.fields.self_hosted_configuration === undefined)
      return false;
    await commitAtomic({ ...readAtomic(), [id]: null });
    return true;
  });
}
