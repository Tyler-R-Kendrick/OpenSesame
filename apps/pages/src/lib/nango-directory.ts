/**
 * A Nango-compatible directory, read by reference (ADR 0115).
 *
 * Nango's HTTP API — the hosted `https://api.nango.dev`, or a self-hosted
 * instance on `:3003` — already holds the OAuth round trips a deployment ran
 * somewhere else. This adapter calls exactly two listing endpoints and keeps
 * what a PAM plane needs about each connection: which integration, which
 * connection id, whose account, and whether Nango reports it healthy.
 *
 * It never calls `GET /connection/{id}`: that is the endpoint that returns
 * credentials, and a token has no business in this page (ADR 0005). Nothing
 * here is vendored from Nango (REUSE.md) — the wire shapes are read
 * tolerantly from the public API, in both the current and the older form, so
 * anything that speaks the same two routes is a directory too.
 */

import {
  type BoundaryValue,
  type JsonObject,
  isJsonObject,
  isNumber,
  isString,
} from "@opensesame/os-domain";
import { targetAddressSpaceFor } from "./local-network-fetch.js";
import { isLoopbackUrl } from "./urls.js";

/** The hosted directory, offered as a fill on the endpoint field. */
export const HOSTED_DIRECTORY = "https://api.nango.dev";

/** Where a self-hosted directory listens by default — a loopback suggestion. */
export const SHIPPED_LOCAL_DIRECTORY = "http://localhost:3003";

const TIMEOUT_MS = 8000;
const MAX_ROWS = 512;

export type DirectoryIntegration = {
  /** Nango's `unique_key` / `provider_config_key`. */
  id: string;
  /** The API behind it — `github`, `slack`, `google-calendar`. */
  provider: string;
  displayName: string;
};

export type DirectoryConnection = {
  /** Nango's internal numeric id, as a string; empty where it is not sent. */
  id: string;
  connectionId: string;
  integrationId: string;
  provider: string;
  /** The integration's display name, else its provider. */
  displayName: string;
  /** The end user Nango recorded for the connection, when it did. */
  endUser: string | null;
  createdAt: string | null;
  /** How many errors Nango reports on it — 0 is a healthy connection. */
  errors: number;
};

export type DirectoryListing = {
  integrations: DirectoryIntegration[];
  connections: DirectoryConnection[];
};

export type DirectoryFailure = "refused" | "unanswered" | "malformed";

/** A failed read, in the words the screen may repeat. */
export class DirectoryError extends Error {
  readonly name = "DirectoryError";
  readonly failure: DirectoryFailure;
  constructor(failure: DirectoryFailure, message: string) {
    super(message);
    this.failure = failure;
  }
}

/**
 * An endpoint this page may call: https anywhere, or http on loopback. The
 * trailing slash and any path are kept, because a proxy may mount the
 * directory under one — only the scheme rule is ours.
 */
export function normalizeDirectoryEndpoint(raw: string): string | null {
  const trimmed = raw.trim().replace(/\/+$/, "");
  if (!trimmed) return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" && !isLoopbackUrl(trimmed)) return null;
  if (parsed.username || parsed.password) return null;
  return trimmed;
}

function text(value: BoundaryValue | undefined, max = 256): string {
  return isString(value) ? value.slice(0, max) : "";
}

function rows(value: BoundaryValue | undefined): JsonObject[] {
  if (!Array.isArray(value)) return [];
  const out: JsonObject[] = [];
  for (const row of value) {
    if (out.length === MAX_ROWS) break;
    if (isJsonObject(row)) out.push(row);
  }
  return out;
}

/** `{ data: [...] }` today, `{ configs: [...] }` on older servers. */
export function parseIntegrations(body: BoundaryValue): DirectoryIntegration[] {
  if (!isJsonObject(body)) return [];
  const listed = rows(body.data ?? body.configs ?? body.integrations);
  const out: DirectoryIntegration[] = [];
  for (const row of listed) {
    const id = text(row.unique_key || row.provider_config_key || row.id, 128);
    if (!id) continue;
    const provider = text(row.provider, 128) || id;
    out.push({
      id,
      provider,
      displayName: text(row.display_name, 128) || provider,
    });
  }
  return out;
}

function endUserOf(row: JsonObject): string | null {
  const user = row.end_user;
  if (!isJsonObject(user)) return null;
  return text(user.display_name) || text(user.email) || text(user.id) || null;
}

function errorCount(value: BoundaryValue | undefined): number {
  if (Array.isArray(value)) return value.length;
  if (isNumber(value) && Number.isSafeInteger(value) && value >= 0)
    return value;
  return 0;
}

/**
 * `{ connections: [...] }` from `GET /connections` (and the older
 * `GET /connection`). Only listing fields are read; a credential, if a server
 * ever put one here, is dropped on the floor.
 */
export function parseConnections(
  body: BoundaryValue,
  integrations: readonly DirectoryIntegration[],
): DirectoryConnection[] {
  if (!isJsonObject(body)) return [];
  const names = new Map(integrations.map((entry) => [entry.id, entry]));
  const out: DirectoryConnection[] = [];
  for (const row of rows(body.connections ?? body.data)) {
    const connectionId = text(row.connection_id, 128);
    const integrationId = text(row.provider_config_key, 128);
    if (!connectionId || !integrationId) continue;
    const known = names.get(integrationId);
    const provider =
      text(row.provider, 128) || known?.provider || integrationId;
    out.push({
      id: isNumber(row.id) ? String(row.id) : text(row.id, 64),
      connectionId,
      integrationId,
      provider,
      displayName: known?.displayName || provider,
      endUser: endUserOf(row),
      createdAt: text(row.created || row.created_at, 64) || null,
      errors: errorCount(row.errors),
    });
  }
  return out;
}

async function fetchJson(
  url: string,
  key: string,
  fetchImpl: typeof fetch,
): Promise<{ status: number; body: BoundaryValue | null }> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (key) headers.Authorization = `Bearer ${key}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const init: RequestInit = {
    method: "GET",
    headers,
    credentials: "omit",
    mode: "cors",
    signal: controller.signal,
  };
  // Chrome's Local Network Access wants the hint for a loopback or LAN host.
  const space = targetAddressSpaceFor(url);
  if (space) Object.assign(init, { targetAddressSpace: space });
  let response: Response;
  try {
    response = await fetchImpl(url, init);
  } catch {
    throw new DirectoryError("unanswered", "That endpoint did not answer.");
  } finally {
    clearTimeout(timer);
  }
  if (response.status === 401 || response.status === 403) {
    throw new DirectoryError(
      "refused",
      "The endpoint refused the key. Use an environment key with read access.",
    );
  }
  let body: BoundaryValue | null = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  return { status: response.status, body };
}

/**
 * Read the directory: integrations first (they name the connections), then
 * the connections. A server that predates `/connections` answers the same
 * list at `/connection`, so a 404 there is retried once on the older path.
 */
export async function listDirectory(
  endpoint: string,
  key: string,
  fetchImpl: typeof fetch = fetch,
): Promise<DirectoryListing> {
  const base = normalizeDirectoryEndpoint(endpoint);
  if (!base) {
    throw new DirectoryError(
      "malformed",
      "Use an https address, or http on loopback.",
    );
  }
  const integrationsReply = await fetchJson(
    `${base}/integrations`,
    key,
    fetchImpl,
  );
  const integrations =
    integrationsReply.status === 200
      ? parseIntegrations(integrationsReply.body)
      : [];
  let reply = await fetchJson(`${base}/connections`, key, fetchImpl);
  if (reply.status === 404) {
    reply = await fetchJson(`${base}/connection`, key, fetchImpl);
  }
  if (reply.status !== 200) {
    throw new DirectoryError(
      "unanswered",
      `The endpoint answered ${reply.status} instead of a connection list.`,
    );
  }
  if (!isJsonObject(reply.body)) {
    throw new DirectoryError(
      "malformed",
      "The endpoint answered, but not with a connection list.",
    );
  }
  return {
    integrations,
    connections: parseConnections(reply.body, integrations),
  };
}
