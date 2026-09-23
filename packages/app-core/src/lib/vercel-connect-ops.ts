/**
 * Connect list/create/authorize/revoke — relay preferred, sealed token fallback.
 */

import {
  type BoundaryValue,
  type JsonObject,
  isJsonObject,
} from "@opensesame/os-domain";
import { env } from "../host.js";
import { maybePage } from "../ports.js";
import { connectCallbackBase } from "./connect-callback.js";
import type { Connection } from "./connections.js";
import { releaseGuestConnection, visibleToGuest } from "./guest-connections.js";
import { isGuestSession } from "./guest-isolation.js";
import { isVercelConnectable } from "./vercel-connect-catalog.js";
import {
  connectorOf,
  iso,
  rows,
  text,
  toConnectConnection,
} from "./vercel-connect-map.js";
import { connectRelayConfigured, relayFetch } from "./vercel-connect-relay.js";
import {
  CONNECT_API,
  ConnectError,
  type VercelConnectAuth,
  appSubject,
  rememberConnector,
  requireAuth,
  requireTransport,
  sdkOptions,
  vercelConnectSeams,
} from "./vercel-connect.js";

export { isConnectConnector, usesConnect } from "./vercel-connect.js";

const TIMEOUT_MS = 8000;

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
  const transport = requireTransport();
  if (transport === "relay") {
    const body = await relayFetch("/api/connect/connectors");
    const listed = isJsonObject(body) ? rows(body.connectors) : [];
    const out: Connection[] = [];
    for (const row of listed) {
      const mapped = toConnectConnection(row, {});
      if (mapped) {
        rememberConnector(mapped.connectionId);
        out.push(mapped);
      }
    }
    return visibleToGuest(out, isGuestSession());
  }
  const auth = transport;
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
  return visibleToGuest(out, isGuestSession());
}

export async function getVercelConnection(id: string): Promise<Connection> {
  if (connectRelayConfigured()) {
    const listed = await listVercelConnections();
    const found = listed.find(
      (row) => row.connectionId === id || row.logicalName === id,
    );
    if (!found) {
      throw new ConnectError(404, "not_found", "Connector not found.");
    }
    rememberConnector(found.connectionId);
    rememberConnector(id);
    return found;
  }
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
  const transport = requireTransport();
  if (transport === "relay") {
    const reply = await relayFetch("/api/connect/connectors", {
      method: "POST",
      body: JSON.stringify({
        service: body.providerId,
        name: body.displayName || body.providerId,
      }),
    });
    const mapped = toConnectConnection(connectorOf(reply) ?? {}, {});
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
  const auth = transport;
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

/**
 * The app address the callback relay bounces the popup to, carrying the
 * connection id the consent poll (and the popup-closer) keys on.
 */
export function connectReturnTo(connectionId: string, origin?: string): string {
  const base = env().BASE_URL || "/";
  const root = origin ?? maybePage()?.location.origin ?? "http://localhost";
  return `${root}${base}connections?connection=${encodeURIComponent(connectionId)}`;
}

export async function authorizeVercelConnection(
  id: string,
  scopes?: string[],
): Promise<VercelAuthorizeResult> {
  const relay = connectCallbackBase().replace(/\/+$/, "");
  const callbackUrl = relay
    ? `${relay}/api/connect/callback?return_to=${encodeURIComponent(connectReturnTo(id))}`
    : undefined;
  if (connectRelayConfigured()) {
    const payload: JsonObject = { connectorId: id };
    if (scopes?.length) payload.scopes = scopes;
    if (callbackUrl) payload.callbackUrl = callbackUrl;
    const reply = await relayFetch("/api/connect/authorize", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    const url = isJsonObject(reply) ? text(reply.url) : "";
    if (!url) {
      throw new ConnectError(
        0,
        "malformed",
        "Connect did not return an authorization URL.",
      );
    }
    const expiresAt =
      isJsonObject(reply) && reply.expiresAt
        ? iso(reply.expiresAt)
        : new Date(Date.now() + 600_000).toISOString();
    return { authorizationUrl: url, expiresAt };
  }
  const auth = requireAuth();
  const reply = await vercelConnectSeams.startAuthorization(
    id,
    appSubject(scopes),
    callbackUrl ? { ...sdkOptions(auth), callbackUrl } : sdkOptions(auth),
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
  const guest = isGuestSession();
  if (guest) releaseGuestConnection(id);
  if (connectRelayConfigured()) {
    try {
      await relayFetch("/api/connect/revoke", {
        method: "POST",
        body: JSON.stringify({ connectorId: id }),
      });
      return { revoked: true, providerRevocation: "ok" };
    } catch (error) {
      if (!guest) throw error;
      return { revoked: true, providerRevocation: "failed" };
    }
  }
  const auth = requireAuth();
  try {
    await vercelConnectSeams.revokeToken(
      id,
      { subject: { type: "app" } },
      sdkOptions(auth),
    );
    return { revoked: true, providerRevocation: "ok" };
  } catch (error) {
    if (!guest) throw error;
    return { revoked: true, providerRevocation: "failed" };
  }
}
