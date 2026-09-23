/**
 * Local access book — grants this device holds when the Host is not there
 * (ADR 0090), and the file a person imports/exports from the pathbar.
 */

import {
  type BoundaryValue,
  isJsonObject,
  isString,
} from "@opensesame/os-domain";
import { kvGet, kvSetDurable } from "./kv.js";

export type LocalGrant = {
  id: string;
  title: string;
  claimant: string;
  resource: string;
  actions: string[];
  mode: string;
  expiresAt: string;
};

const KEY = "access.book.v1";

export const accessBookSeams = {
  read: (): string | null => kvGet(KEY),
  write: (raw: string): void => {
    kvSetDurable(KEY, raw);
  },
};

function isTimestamp(value: string): boolean {
  return value.includes("T") && Number.isFinite(Date.parse(value));
}

function parseGrant(value: BoundaryValue): LocalGrant | null {
  if (!isJsonObject(value) || !isString(value.id) || !isString(value.title)) {
    return null;
  }
  const title = value.title.trim();
  if (!title) return null;
  const actions = Array.isArray(value.actions)
    ? value.actions.filter(isString)
    : [];
  return {
    id: value.id,
    title,
    claimant: isString(value.claimant) ? value.claimant : "local",
    resource: isString(value.resource) ? value.resource : title,
    actions,
    mode: isString(value.mode) ? value.mode : "broker",
    expiresAt:
      isString(value.expiresAt) && isTimestamp(value.expiresAt)
        ? value.expiresAt
        : new Date(Date.now() + 3_600_000).toISOString(),
  };
}

function load(): LocalGrant[] {
  const raw = accessBookSeams.read();
  if (!raw) return [];
  try {
    const parsed: BoundaryValue = JSON.parse(raw);
    const rows =
      isJsonObject(parsed) && Array.isArray(parsed.grants)
        ? parsed.grants
        : Array.isArray(parsed)
          ? parsed
          : [];
    return rows
      .map(parseGrant)
      .filter((row): row is LocalGrant => row !== null);
  } catch {
    return [];
  }
}

function save(rows: LocalGrant[]): void {
  accessBookSeams.write(JSON.stringify({ version: 1, grants: rows }));
}

export function listLocalGrants(): LocalGrant[] {
  return load();
}

export type LocalGrantDraft = {
  title: string;
  claimant?: string;
  resource?: string;
  actions?: string[];
  mode?: string;
  expiresInSeconds?: number;
};

export function addLocalGrant(input: LocalGrantDraft): LocalGrant {
  const title = input.title.trim();
  if (!title) throw new Error("A grant needs a title.");
  const ttl = (input.expiresInSeconds ?? 3_600) * 1000;
  const record: LocalGrant = {
    id: `gr_local_${crypto.randomUUID()}`,
    title,
    claimant: input.claimant?.trim() || "local",
    resource: input.resource?.trim() || title,
    actions: input.actions ?? [],
    mode: input.mode?.trim() || "broker",
    expiresAt: new Date(Date.now() + ttl).toISOString(),
  };
  save([...load(), record]);
  return record;
}

export function putLocalGrant(record: LocalGrant): boolean {
  const rows = load();
  if (rows.some((row) => row.id === record.id)) return false;
  save([...rows, record]);
  return true;
}

export function removeLocalGrant(id: string): void {
  save(load().filter((row) => row.id !== id));
}

export function exportAccessBook(): string {
  return `${JSON.stringify({ version: 1, grants: load() }, null, 2)}\n`;
}

export type AccessImportResult = { added: number };

export function importAccessBook(raw: string): AccessImportResult {
  let parsed: BoundaryValue;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("That file is not an access book.");
  }
  const rows =
    isJsonObject(parsed) && Array.isArray(parsed.grants)
      ? parsed.grants
      : Array.isArray(parsed)
        ? parsed
        : [];
  let added = 0;
  for (const row of rows) {
    const record = parseGrant(row);
    if (!record) {
      if (isJsonObject(row) && isString(row.title) && row.title.trim()) {
        const draft: LocalGrantDraft = {
          title: row.title,
          claimant: isString(row.claimant) ? row.claimant : undefined,
          resource: isString(row.resource) ? row.resource : undefined,
          actions: Array.isArray(row.actions)
            ? row.actions.filter(isString)
            : undefined,
          mode: isString(row.mode) ? row.mode : undefined,
        };
        addLocalGrant(draft);
        added += 1;
      }
      continue;
    }
    if (putLocalGrant(record)) added += 1;
  }
  return { added };
}
