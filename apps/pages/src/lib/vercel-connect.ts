/**
 * Vercel Connect client. Authorize/get/revoke go through `@vercel/connect`.
 * List/create stay on the Connect REST routes the SDK does not export.
 * Never call `getToken`: tokens stay in Connect (ADR 0005).
 */

import {
  type BoundaryValue,
  type JsonObject,
  isJsonObject,
} from "@opensesame/os-domain";
import {
  getConnectorMetadata,
  revokeToken,
  startAuthorization,
} from "@vercel/connect";
import { useSyncExternalStore } from "react";
import type { Connection } from "./connections.js";
import { isVercelConnectable } from "./vercel-connect-catalog.js";
import {
  connectorOf,
  iso,
  rows,
  text,
  toConnectConnection,
} from "./vercel-connect-map.js";

export { toConnectConnection } from "./vercel-connect-map.js";

export const CONNECT_API = "https://api.vercel.com";
const TIMEOUT_MS = 8000;
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
/** Connector ids listed or created on the live Connect transport this session. */
const knownConnectors = new Set<string>();

function rememberConnector(id: string): void {
  if (id) knownConnectors.add(id);
}

export function vercelConnectAuth(): VercelConnectAuth | null {
  return sessionAuth;
}

/** Live Connect transport, never custom or blocked catalog ids. */
export function usesConnect(providerId?: string): boolean {
  if (!sessionAuth?.token) return false;
  if (providerId === undefined) return true;
  return isVercelConnectable(providerId);
}

/** True only for connectors this session listed or created via Connect. */
export function isConnectConnector(id: string): boolean {
  return Boolean(sessionAuth?.token) && knownConnectors.has(id);
}

export function vercelConnectConfigured(): boolean {
  return Boolean(vercelConnectAuth()?.token);
}

export function setVercelConnectAuth(next: VercelConnectAuth | null): void {
  sessionAuth = next;
  if (!next) knownConnectors.clear();
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
  if (scopes?.length) {
    return { subject: { type: "app" as const }, scopes };
  }
  return { subject: { type: "app" as const } };
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

type TeamQueryExtra = {
  limit?: string;
  projectId?: string;
};

function teamQuery(auth: VercelConnectAuth, extra: TeamQueryExtra = {}) {
  const params = new URLSearchParams();
  if (extra.limit) params.set("limit", extra.limit);
  if (extra.projectId) params.set("projectId", extra.projectId);
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

export async function listVercelConnections(): Promise<Connection[]> {
  const auth = requireAuth();
  const extra = auth.projectId
    ? { limit: "100", projectId: auth.projectId }
    : { limit: "100" };
  const body = await connectFetch(
    `/v2/connect/connectors${teamQuery(auth, extra)}`,
  );
  const listed = isJsonObject(body) ? rows(body.connectors) : [];
  const out: Connection[] = [];
  for (const row of listed) {
    const mapped = toConnectConnection(row, auth);
    if (mapped) {
      rememberConnector(mapped.connectionId);
      out.push(mapped);
    }
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
  rememberConnector(mapped.connectionId);
  rememberConnector(id);
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
  rememberConnector(mapped.connectionId);
  return mapped;
}

export type VercelAuthorizeResult = {
  authorizationUrl: string;
  expiresAt: string;
};

export async function authorizeVercelConnection(
  id: string,
  scopes?: string[],
): Promise<VercelAuthorizeResult> {
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

export type VercelRevokeResult = {
  revoked: boolean;
  providerRevocation: "ok" | "unsupported" | "failed";
};

export async function revokeVercelConnection(
  id: string,
): Promise<VercelRevokeResult> {
  const auth = requireAuth();
  await vercelConnectSeams.revokeToken(
    id,
    { subject: { type: "app" } },
    sdkOptions(auth),
  );
  return { revoked: true, providerRevocation: "ok" };
}
