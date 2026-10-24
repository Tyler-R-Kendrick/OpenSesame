/**
 * Self-managed honey tokens.
 *
 * A token is a synthetic proxy key (`osr_hny_<id>_<secret>`) that this app
 * issues and a person plants beside real secrets. It is never bound to a
 * connection or a live run: the surrogate proxy recognises the reserved
 * prefix itself, refuses the request, and writes a critical
 * `surrogate.honey_token` notice whose subject is the public id. No provider
 * account, CloudTrail trail, or native honey-token setup is involved.
 *
 * The token is stored in the vault's sealed local store so the person can
 * copy it again. The id is public; the secret is the only part a notice never
 * carries.
 */

import {
  type JsonObject,
  type JsonValue,
  isJsonObject,
  isNumber,
  isString,
} from "@opensesame/os-domain";
import { kvGet, kvSetDurable } from "./kv.js";

export const HONEY_TOKEN_KEY = "settings.honey-tokens.v1";
export const HONEY_TOKEN_MARKER = "osr_hny_";
export const HONEY_ID_PREFIX = "c0de";
export const HONEY_TOKEN_ID_LEN = 32;
export const HONEY_TOKEN_SECRET_LEN = 32;
export const MAX_HONEY_TOKENS = 128;

export type HoneyTokenRecord = Readonly<{
  id: string;
  scope: string;
  label: string;
  token: string;
  createdAt: number;
  revokedAt: number | null;
  triggeredAt: number | null;
  lastTriggeredAt: number | null;
}>;

export type HoneyTokenStatus = "active" | "triggered" | "revoked";

type Stored = { version: 1; tokens: HoneyTokenRecord[] };

const ID = /^[0-9a-f]{32}$/u;
const TOKEN = /^(?:osr_hny_[0-9a-f]{32}_[0-9a-f]{32}|osr_c0de[0-9a-f]{28})$/u;

/** A freshly minted decoy: its public id and the token a person plants. */
export type HoneyTokenMint = { id: string; token: string };

export function mintHoneyToken(): HoneyTokenMint {
  // The HoneyVault token is a normal proxy-key shape. Only the reserved id
  // namespace tells the proxy it is a decoy; nothing says "honey" in the value.
  const id = `${HONEY_ID_PREFIX}${hex(16).slice(4)}`;
  return { id, token: `osr_${id}` };
}

function hex(bytes: number): string {
  return [...crypto.getRandomValues(new Uint8Array(bytes))]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

function optionalTime(value: JsonValue | undefined): number | null | undefined {
  if (value === null) return null;
  return isNumber(value) && Number.isSafeInteger(value) && value > 0
    ? value
    : undefined;
}

type HoneyTokenIdentity = Pick<
  HoneyTokenRecord,
  "id" | "scope" | "label" | "token"
>;

/** The record's identity fields, when every one of them reads. */
function identity(row: JsonObject): HoneyTokenIdentity | null {
  const { id, scope, label, token } = row;
  if (!isString(id) || !ID.test(id)) return null;
  if (!isString(scope) || scope.length === 0 || scope.length > 128) return null;
  if (!isString(label) || label.length === 0 || label.length > 80) return null;
  if (!isString(token) || !TOKEN.test(token)) return null;
  const marked = token.slice(
    HONEY_TOKEN_MARKER.length,
    HONEY_TOKEN_MARKER.length + 32,
  );
  return marked === id ? { id, scope, label, token } : null;
}

function normalize(value: JsonValue): HoneyTokenRecord | null {
  if (!isJsonObject(value)) return null;
  const named = identity(value);
  if (!named) return null;
  const createdAt = optionalTime(value.createdAt);
  const revokedAt = optionalTime(value.revokedAt);
  const triggeredAt = optionalTime(value.triggeredAt);
  const lastTriggeredAt = optionalTime(value.lastTriggeredAt);
  if (
    createdAt === null ||
    createdAt === undefined ||
    revokedAt === undefined ||
    triggeredAt === undefined ||
    lastTriggeredAt === undefined
  )
    return null;
  return { ...named, createdAt, revokedAt, triggeredAt, lastTriggeredAt };
}

function readAll(): HoneyTokenRecord[] {
  const raw = kvGet(HONEY_TOKEN_KEY);
  if (raw === null) return [];
  try {
    const parsed: JsonValue = JSON.parse(raw);
    if (!isJsonObject(parsed)) return [];
    if (parsed.version !== 1 || !Array.isArray(parsed.tokens)) return [];
    return parsed.tokens
      .map(normalize)
      .filter((row): row is HoneyTokenRecord => row !== null);
  } catch {
    return [];
  }
}

async function writeAll(tokens: readonly HoneyTokenRecord[]): Promise<void> {
  const document: Stored = { version: 1, tokens: [...tokens] };
  await kvSetDurable(HONEY_TOKEN_KEY, JSON.stringify(document));
}

/**
 * Every mutation reads the whole document, changes one row and writes it
 * back. Serialize the whole read-modify-write, not just the write, or two
 * quick actions each keep their own stale copy.
 */
let mutations: Promise<void> = Promise.resolve();
function serialized<T>(work: () => Promise<T> | T): Promise<T> {
  const run = mutations.then(work, work);
  mutations = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

export function honeyTokenStatus(token: HoneyTokenRecord): HoneyTokenStatus {
  if (token.revokedAt !== null) {
    return token.lastTriggeredAt !== null &&
      token.lastTriggeredAt > token.revokedAt
      ? "triggered"
      : "revoked";
  }
  return token.triggeredAt === null ? "active" : "triggered";
}

/** The id in a well-formed token, or null for any near miss. */
export function honeyTokenId(value: string): string | null {
  if (!TOKEN.test(value)) return null;
  if (value.startsWith("osr_c0de")) return value.slice(4);
  return value.slice(HONEY_TOKEN_MARKER.length, HONEY_TOKEN_MARKER.length + 32);
}

export function listHoneyTokens(scope: string): HoneyTokenRecord[] {
  return readAll()
    .filter((row) => row.scope === scope)
    .sort((left, right) => right.createdAt - left.createdAt);
}

export async function issueHoneyToken(
  scope: string,
  label: string,
  now = Date.now(),
): Promise<HoneyTokenRecord> {
  return serialized(async () => {
    const clean = label.trim();
    if (clean === "" || clean.length > 80)
      throw new Error("Give the honey token a name of 80 characters or fewer.");
    const current = readAll();
    if (current.filter((row) => row.scope === scope).length >= MAX_HONEY_TOKENS)
      throw new Error("This vault already holds the maximum honey tokens.");
    let id = hex(16);
    while (current.some((row) => row.id === id)) id = hex(16);
    const token = `${HONEY_TOKEN_MARKER}${id}_${hex(16)}`;
    const record: HoneyTokenRecord = {
      id,
      scope,
      label: clean,
      token,
      createdAt: now,
      revokedAt: null,
      triggeredAt: null,
      lastTriggeredAt: null,
    };
    await writeAll([...current, record]);
    return record;
  });
}

/** Record a token minted by a decoy-vault plan. The token itself is unchanged. */
export async function registerHoneyToken(
  scope: string,
  label: string,
  token: string,
  now = Date.now(),
): Promise<HoneyTokenRecord> {
  const clean = label.trim();
  const id = honeyTokenId(token);
  if (clean === "" || clean.length > 80 || id === null)
    throw new Error("That is not a valid honey token.");
  return serialized(async () => {
    const current = readAll();
    if (current.some((row) => row.id === id))
      throw new Error("This honey token is already recorded.");
    if (current.filter((row) => row.scope === scope).length >= MAX_HONEY_TOKENS)
      throw new Error("This vault already holds the maximum honey tokens.");
    const record: HoneyTokenRecord = {
      id,
      scope,
      label: clean,
      token,
      createdAt: now,
      revokedAt: null,
      triggeredAt: null,
      lastTriggeredAt: null,
    };
    await writeAll([...current, record]);
    return record;
  });
}

export async function revokeHoneyToken(
  scope: string,
  id: string,
  now = Date.now(),
): Promise<HoneyTokenRecord | null> {
  return serialized(async () => {
    let changed: HoneyTokenRecord | null = null;
    const next = readAll().map((row) => {
      if (row.scope !== scope || row.id !== id) return row;
      changed = { ...row, revokedAt: now };
      return changed;
    });
    if (changed !== null) await writeAll(next);
    return changed;
  });
}

export async function resetHoneyToken(
  scope: string,
  id: string,
  now = Date.now(),
): Promise<HoneyTokenRecord | null> {
  return serialized(async () => {
    let changed: HoneyTokenRecord | null = null;
    const next = readAll().map((row) => {
      if (row.scope !== scope || row.id !== id) return row;
      changed = {
        ...row,
        revokedAt: null,
        triggeredAt: null,
        lastTriggeredAt: Math.max(row.lastTriggeredAt ?? 0, now),
      };
      return changed;
    });
    if (changed !== null) await writeAll(next);
    return changed;
  });
}

export type HoneyTokenNotice = Readonly<{
  event: string;
  at: string;
  subject: string | null;
}>;

/**
 * Match the proxy's critical notices to the planted ids. A notice for an id
 * this vault does not hold is ignored: the reserved prefix means a forged
 * token can create noise, never a false alert in this list.
 */
export async function reconcileHoneyTokenNotices(
  scope: string,
  notices: readonly HoneyTokenNotice[],
): Promise<HoneyTokenRecord[]> {
  return serialized(async () => {
    const hits = new Map<string, number>();
    for (const notice of notices) {
      if (notice.event !== "surrogate.honey_token" || notice.subject === null)
        continue;
      const at = Date.parse(notice.at);
      if (Number.isNaN(at)) continue;
      hits.set(notice.subject, Math.max(hits.get(notice.subject) ?? 0, at));
    }
    const current = readAll();
    let changed = false;
    const next = current.map((row) => {
      if (row.scope !== scope) return row;
      const at = hits.get(row.id);
      if (at === undefined || (row.lastTriggeredAt ?? 0) >= at) return row;
      changed = true;
      return {
        ...row,
        triggeredAt: row.triggeredAt ?? at,
        lastTriggeredAt: at,
      };
    });
    if (changed) await writeAll(next);
    return next
      .filter((row) => row.scope === scope)
      .sort((left, right) => right.createdAt - left.createdAt);
  });
}
