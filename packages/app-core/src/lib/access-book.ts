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
  /** Durable: settles once storage holds `raw`, rejects if it would not. */
  write: (raw: string): Promise<void> | void => kvSetDurable(KEY, raw),
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

/**
 * The book as last written, until storage settles. A durable write puts the
 * value in memory only once storage has it, so reading back straight after
 * a write saw the old book: a listener read the grant it was told about as
 * missing, and an import kept only its last row.
 */
let pending: string | null = null;

function load(): LocalGrant[] {
  const raw = pending ?? accessBookSeams.read();
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

const listeners = new Set<() => void>();
let version = 0;

/**
 * Called after every write to the book, and again once storage settles it
 * (a refused write falls back to what storage holds), so a view can follow.
 */
export function subscribeAccessBook(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Moves on every change a subscriber is told about; a stable snapshot. */
export function accessBookVersion(): number {
  return version;
}

function notify(): void {
  version += 1;
  for (const listener of [...listeners]) listener();
}

function save(rows: LocalGrant[]): void {
  const raw = JSON.stringify({ version: 1, grants: rows });
  pending = raw;
  notify();
  const settle = () => {
    if (pending !== raw) return;
    pending = null;
    notify();
  };
  void Promise.resolve()
    .then(() => accessBookSeams.write(raw))
    .then(settle, settle);
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

function draftGrant(input: LocalGrantDraft): LocalGrant {
  const title = input.title.trim();
  if (!title) throw new Error("A grant needs a title.");
  const ttl = (input.expiresInSeconds ?? 3_600) * 1000;
  return {
    id: `gr_local_${crypto.randomUUID()}`,
    title,
    claimant: input.claimant?.trim() || "local",
    resource: input.resource?.trim() || title,
    actions: input.actions ?? [],
    mode: input.mode?.trim() || "broker",
    expiresAt: new Date(Date.now() + ttl).toISOString(),
  };
}

export function addLocalGrant(input: LocalGrantDraft): LocalGrant {
  const record = draftGrant(input);
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

/** A row with a title but no usable id: kept as a new grant of that name. */
function importedDraft(row: BoundaryValue): LocalGrant | null {
  if (!isJsonObject(row) || !isString(row.title) || !row.title.trim()) {
    return null;
  }
  return draftGrant({
    title: row.title,
    claimant: isString(row.claimant) ? row.claimant : undefined,
    resource: isString(row.resource) ? row.resource : undefined,
    actions: Array.isArray(row.actions)
      ? row.actions.filter(isString)
      : undefined,
    mode: isString(row.mode) ? row.mode : undefined,
  });
}

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
  // One write for the whole file: row by row, each save told every
  // subscriber and each read parsed the book again.
  const book = load();
  let added = 0;
  for (const row of rows) {
    const record = parseGrant(row) ?? importedDraft(row);
    if (!record || book.some((held) => held.id === record.id)) continue;
    book.push(record);
    added += 1;
  }
  if (added > 0) save(book);
  return { added };
}
