/**
 * The two device records a saved connector uses: public rows, and the
 * secret map that never rides on the connection the page renders.
 */

import {
  type BoundaryValue,
  isJsonObject,
  isString,
} from "@opensesame/os-domain";
import { kvDelete, kvGet, kvSet } from "./kv.js";

const PUBLIC_KEY = "opensesame.device-connectors.v1";
const SECRET_KEY = "opensesame.device-connector-secrets.v1";

/** Both records, for a boot that reads a saved connector before anything draws. */
export const DEVICE_CONNECTOR_KEYS: readonly string[] = [
  PUBLIC_KEY,
  SECRET_KEY,
];

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

export function readDeviceRows(): PublicRow[] {
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

export function writeDeviceRows(rows: PublicRow[]): void {
  if (rows.length === 0) kvDelete(PUBLIC_KEY);
  else kvSet(PUBLIC_KEY, JSON.stringify(rows));
}

export function readDeviceSecrets(): SecretStore {
  const raw = kvGet(SECRET_KEY);
  if (!raw) return {};
  try {
    const parsed: BoundaryValue = JSON.parse(raw);
    if (!isJsonObject(parsed)) return {};
    const map: SecretStore = {};
    for (const [id, entry] of Object.entries(parsed)) {
      if (!isJsonObject(entry)) continue;
      const secrets: StringFields = {};
      for (const [name, value] of Object.entries(entry)) {
        if (isString(value)) secrets[name] = value;
      }
      map[id] = secrets;
    }
    return map;
  } catch {
    return {};
  }
}

export function writeDeviceSecrets(map: SecretStore): void {
  if (Object.keys(map).length === 0) kvDelete(SECRET_KEY);
  else kvSet(SECRET_KEY, JSON.stringify(map));
}
