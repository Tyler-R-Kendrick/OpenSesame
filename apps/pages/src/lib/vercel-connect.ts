/**
 * Vercel Connect client. Authorize/get/revoke go through `@vercel/connect`.
 * List/create stay on the Connect REST routes the SDK does not export.
 * Never call `getToken`: tokens stay in Connect (ADR 0005).
 */

import {
  type BoundaryValue,
  type JsonObject,
  isJsonObject,
  isNumber,
  isString,
} from "@opensesame/os-domain";
import {
  getConnectorMetadata,
  revokeToken,
  startAuthorization,
} from "@vercel/connect";
import { useSyncExternalStore } from "react";
import type { Connection } from "./connections.js";
import { isVercelConnectable } from "./vercel-connect-catalog.js";

export const CONNECT_API = "https://api.vercel.com";
const TIMEOUT_MS = 8000;
const EMPTY_EGRESS = {
  scheme: "https",
  authorities: [] as string[],
  pathPrefixes: [] as string[],
};

export type VercelConnectAuth = {
  token: string;
  teamId?: string;
  projectId?: string;
};

export class ConnectError extends Error {
  readonly name = "ConnectError";
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

let sessionAuth: VercelConnectAuth | null = null;
const listeners = new Set<() => void>();

export function vercelConnectAuth(): VercelConnectAuth | null {
  return sessionAuth;
}

/** Live Connect transport, never custom or blocked catalog ids. */
export function usesConnect(providerId?: string): boolean {
  if (!sessionAuth?.token) return false;
  if (providerId === undefined) return true;
  return isVercelConnectable(providerId);
}

export function vercelConnectConfigured(): boolean {
  return Boolean(vercelConnectAuth()?.token);
}

export function setVercelConnectAuth(next: VercelConnectAuth | null): void {
  sessionAuth = next;
  for (const listener of listeners) listener();
}

export function subscribeVercelConnectAuth(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useVercelConnectConfigured(): boolean {
  return useSyncExternalStore(
    subscribeVercelConnectAuth,
    vercelConnectConfigured,
    vercelConnectConfigured,
  );
}

export const vercelConnectSeams = {
  fetch: (input: RequestInfo | URL, init?: RequestInit) => fetch(input, init),
  auth: vercelConnectAuth,
  startAuthorization,
  getConnectorMetadata,
  revokeToken,
};

function sdkOptions(auth: VercelConnectAuth) {
  return { vercelToken: auth.token };
}

function appSubject(scopes?: string[]) {
  return {
    subject: { type: "app" as const },
    ...(scopes?.length ? { scopes } : {}),
  };
}

function requireAuth(): VercelConnectAuth {
  const auth = vercelConnectSeams.auth();
  if (!auth?.token) {
    throw new ConnectError(
      0,
      "unconfigured",
      "Vercel Connect is not configured.",
    );
  }
  return auth;
}

function text(value: BoundaryValue | undefined, max = 256): string {
  return isString(value) ? value.slice(0, max) : "";
}

function iso(value: BoundaryValue | undefined): string {
  if (isNumber(value) && Number.isFinite(value) && value > 0) {
    return new Date(value).toISOString();
  }
  const raw = text(value);
  if (!raw) return "";
  const numeric = Number(raw);
  const ms =
    Number.isFinite(numeric) && numeric > 0 ? numeric : Date.parse(raw);
  if (!Number.isFinite(ms) || ms <= 0) return "";
  return new Date(ms).toISOString();
}

function scopeNames(value: BoundaryValue | undefined): string[] {
  if (!isJsonObject(value) || !Array.isArray(value.scopes)) return [];
  return value.scopes.filter(isString).slice(0, 64);
}

function teamQuery(
  auth: VercelConnectAuth,
  extra: Record<string, string> = {},
) {
  const params = new URLSearchParams(extra);
  if (auth.teamId) params.set("teamId", auth.teamId);
  const query = params.toString();
  return query ? `?${query}` : "";
}

async function connectFetch(
  path: string,
  init: RequestInit = {},
): Promise<BoundaryValue> {
  if (path.includes("/connect/token")) {
    throw new ConnectError(0, "refused", "Connect tokens stay in Connect.");
  }
  const auth = requireAuth();
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${auth.token}`);
  headers.set("accept", "application/json");
  if (init.body && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    let response: Response;
    try {
      response = await vercelConnectSeams.fetch(`${CONNECT_API}${path}`, {
        ...init,
        headers,
        credentials: "omit",
        mode: "cors",
        signal: controller.signal,
      });
    } catch {
      throw new ConnectError(
        0,
        "unreachable",
        "Couldn't reach the connected service.",
      );
    }
    const body: BoundaryValue = await response.json().catch(() => null);
    if (!response.ok) {
      const error =
        isJsonObject(body) && isJsonObject(body.error) ? body.error : {};
      throw new ConnectError(
        response.status,
        text(error.code, 64) || "unknown_error",
        text(error.message) || "Request failed.",
      );
    }
    return body;
  } finally {
    clearTimeout(timer);
  }
}

function rows(value: BoundaryValue | undefined): JsonObject[] {
  if (!Array.isArray(value)) return [];
  const out: JsonObject[] = [];
  for (const item of value) {
    if (isJsonObject(item)) out.push(item);
    if (out.length === 100) break;
  }
  return out;
}

function connectorOf(value: BoundaryValue): JsonObject | null {
  if (isJsonObject(value) && isJsonObject(value.connector))
    return value.connector;
  return isJsonObject(value) ? value : null;
}

function egressOf(row: JsonObject): Connection["egress"] {
  const raw = text(row.clientUrl) || text(row.website);
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:") return EMPTY_EGRESS;
    return { scheme: "https", authorities: [url.host], pathPrefixes: [] };
  } catch {
    return EMPTY_EGRESS;
  }
}

export function toConnectConnection(
  row: JsonObject,
  auth: VercelConnectAuth,
): Connection | null {
  const id =
    text(row.id, 128) || text(row.uid, 128) || text(row.connectorId, 128);
  if (!id) return null;
  const service = text(row.service, 128) || id;
  const createdAt = iso(row.createdAt);
  return {
    connectionId: id,
    connectionRef: `connect://${text(row.uid, 128) || id}`,
    logicalName: text(row.uid, 128) || text(row.name, 128) || service,
    displayName: text(row.displayName) || text(row.name) || service,
    providerId: service,
    integrationId: null,
    status: row.reinstallAt ? "needs_reauth" : "active",
    statusDetail: null,
    organizationId: auth.teamId || "",
    projectId: auth.projectId || null,
    ownerKind: "organization",
    shareability: "delegable",
    requestedScopes: [],
    grantedScopes: [
      ...scopeNames(row.userTokens),
      ...scopeNames(row.appTokens),
    ],
    accountLabel: text(row.name) || null,
    expiresAt: null,
    refreshable: true,
    lastRefreshedAt: null,
    maxInvokeLevel: 2,
    egress: egressOf(row),
    bindings: [],
    createdAt,
    updatedAt: iso(row.updatedAt) || createdAt,
  };
}

export async function listVercelConnections(): Promise<Connection[]> {
  const auth = requireAuth();
  const extra: Record<string, string> = { limit: "100" };
  if (auth.projectId) extra.projectId = auth.projectId;
  const body = await connectFetch(
    `/v2/connect/connectors${teamQuery(auth, extra)}`,
  );
  const listed = isJsonObject(body) ? rows(body.connectors) : [];
  const out: Connection[] = [];
  for (const row of listed) {
    const mapped = toConnectConnection(row, auth);
    if (mapped) out.push(mapped);
  }
  return out;
}

export async function getVercelConnection(id: string): Promise<Connection> {
  const auth = requireAuth();
  const meta = await vercelConnectSeams.getConnectorMetadata(
    id,
    sdkOptions(auth),
  );
  const mapped = toConnectConnection(
    {
      id: meta.id,
      uid: meta.uid,
      name: meta.name,
      displayName: meta.name,
      service: meta.service,
      type: meta.type,
      clientUrl: meta.clientUrl,
      createdAt: meta.createdAt,
      updatedAt: meta.updatedAt,
    },
    auth,
  );
  if (!mapped) {
    throw new ConnectError(
      0,
      "malformed",
      "Connect did not return a connector.",
    );
  }
  return mapped;
}

export async function createVercelConnection(body: {
  providerId: string;
  displayName?: string;
  scopes?: string[];
  projectId?: string;
}): Promise<Connection> {
  if (!isVercelConnectable(body.providerId)) {
    throw new ConnectError(0, "refused", "This connector is not connectable.");
  }
  const auth = requireAuth();
  const projectId = body.projectId || auth.projectId;
  const payload: JsonObject = {
    service: body.providerId,
    name: body.displayName || body.providerId,
  };
  if (projectId) payload.projectId = projectId;
  const reply = await connectFetch(`/v1/connect/connectors${teamQuery(auth)}`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
  const mapped = toConnectConnection(connectorOf(reply) ?? {}, auth);
  if (!mapped) {
    throw new ConnectError(
      0,
      "malformed",
      "Connect did not return a connector.",
    );
  }
  return mapped;
}

export async function authorizeVercelConnection(
  id: string,
  scopes?: string[],
): Promise<{ authorizationUrl: string; expiresAt: string }> {
  const auth = requireAuth();
  const reply = await vercelConnectSeams.startAuthorization(
    id,
    appSubject(scopes),
    sdkOptions(auth),
  );
  if (!reply.url) {
    throw new ConnectError(
      0,
      "malformed",
      "Connect did not return an authorization URL.",
    );
  }
  return {
    authorizationUrl: reply.url,
    expiresAt: reply.expiresAt
      ? iso(reply.expiresAt)
      : new Date(Date.now() + 600_000).toISOString(),
  };
}

export async function revokeVercelConnection(id: string): Promise<{
  revoked: boolean;
  providerRevocation: "ok" | "unsupported" | "failed";
}> {
  const auth = requireAuth();
  await vercelConnectSeams.revokeToken(
    id,
    { subject: { type: "app" } },
    sdkOptions(auth),
  );
  return { revoked: true, providerRevocation: "ok" };
}
