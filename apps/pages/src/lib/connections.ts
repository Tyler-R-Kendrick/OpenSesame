/**
 * Connection broker client (Host plane).
 *
 * Connections are the one thing OpenSesame holds on the user's behalf: the
 * authority plane must be able to decrypt a provider token to inject it at
 * egress and to refresh it while nobody is watching. That is the opposite of
 * the vault, and the UI has to keep the two apart. Nothing here ever receives
 * an access token, a refresh token, or a client secret — the API does not
 * expose them (ADR 0032).
 */

import {
  AuthorizeResponseSchema,
  BindingSchema,
  ConnectionErrorResponseSchema,
  ConnectionEventSchema,
  ConnectionSchema,
  DiscoverConnectionsResponseSchema,
  ListConnectionsResponseSchema,
  ListEventsResponseSchema,
  ListProvidersResponseSchema,
  ProviderSchema,
  RevokeResponseSchema,
} from "@opensesame/contracts";
import { hostBase, hostFetch } from "./identity.js";

export type ProviderCategory =
  | "encryption"
  | "cloud_secret_storage"
  | "password_managers"
  | "local_storage"
  | "developer"
  | "productivity"
  | "communication"
  | "storage"
  | "crm"
  | "payments"
  | "identity"
  | "testing";

export type AuthKind =
  | "oauth2_authorization_code"
  | "api_key"
  | "configuration";

export type ConfigurationField = {
  name: string;
  label: string;
  secret: boolean;
  required: boolean;
};

export type ScopeDef = {
  name: string;
  description: string;
  sensitive: boolean;
  default: boolean;
};

export type Egress = {
  scheme: string;
  authorities: string[];
  pathPrefixes: string[];
};

export type Provider = {
  id: string;
  displayName: string;
  category: ProviderCategory;
  docsUrl: string;
  authKind: AuthKind;
  supportsRefresh: boolean;
  /** Deployment has a client id and secret for this provider. */
  configured: boolean;
  /** Host can supply every connection field without asking the user. */
  autoConfigurable: boolean;
  /** Exact environment variables the deployment is missing. Empty when configured. */
  missingConfig: string[];
  scopes: ScopeDef[];
  egress: Egress;
  operations: string[];
  configurationFields?: ConfigurationField[];
};

export type ConnectionStatus =
  | "pending"
  | "active"
  | "needs_reauth"
  | "expired"
  | "revoked"
  | "error";

export type BindingTargetKind =
  | "organization"
  | "project"
  | "agent"
  | "group"
  | "device"
  | "identity";

export type Binding = {
  id: string;
  targetKind: BindingTargetKind;
  targetId: string;
  targetLabel: string | null;
  createdAt: string;
};

export type ConnectionEventKind =
  | "created"
  | "authorize_started"
  | "authorized"
  | "refreshed"
  | "refresh_failed"
  | "bound"
  | "unbound"
  | "policy_updated"
  | "revoked"
  | "error";

export type ConnectionEvent = {
  id: string;
  kind: ConnectionEventKind;
  at: string;
  detail: string | null;
};

export type Connection = {
  connectionId: string;
  connectionRef: string;
  logicalName: string;
  displayName: string;
  providerId: string;
  status: ConnectionStatus;
  statusDetail: string | null;
  organizationId: string;
  projectId: string | null;
  ownerKind: string;
  shareability: "private" | "delegable" | "organization_wide";
  requestedScopes: string[];
  grantedScopes: string[];
  accountLabel: string | null;
  expiresAt: string | null;
  refreshable: boolean;
  lastRefreshedAt: string | null;
  maxInvokeLevel: number;
  egress: Egress;
  bindings: Binding[];
  createdAt: string;
  updatedAt: string;
};

export class ConnectionsError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ConnectionsError";
  }
}

/* ------------------------------------------------------------- transport */

function base(): string {
  return hostBase();
}

async function call<T>(
  path: string,
  init: RequestInit = {},
  map: (body: unknown) => T = (body) => body as T,
): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }

  let res: Response;
  try {
    res = await hostFetch(`/api/v1${path}`, {
      ...init,
      headers,
    });
  } catch (error) {
    if (error instanceof Error && !(error instanceof TypeError)) throw error;
    throw new ConnectionsError(
      0,
      "unreachable",
      `Host API unreachable at ${base()}.`,
    );
  }

  if (!res.ok) {
    const body = await res.json().catch(() => null);
    const parsed = ConnectionErrorResponseSchema.safeParse(body);
    throw new ConnectionsError(
      res.status,
      parsed.success ? parsed.data.error : "unknown_error",
      parsed.success ? parsed.data.hint : "Request failed.",
    );
  }
  if (res.status === 204) return map(null);
  return map(await res.json());
}

/* ----------------------------------------------------------- wire mapping */

function obj(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

function toEgress(raw: {
  scheme: string;
  authorities: string[];
  path_prefixes: string[];
}): Egress {
  return {
    scheme: raw.scheme,
    authorities: raw.authorities,
    pathPrefixes: raw.path_prefixes,
  };
}

function toProvider(value: unknown): Provider {
  const raw = ProviderSchema.parse(value);
  return {
    id: raw.id,
    displayName: raw.display_name,
    category: raw.category,
    docsUrl: raw.docs_url,
    authKind: raw.auth_kind,
    supportsRefresh: raw.supports_refresh,
    configured: raw.configured,
    autoConfigurable: raw.auto_configurable,
    missingConfig: raw.missing_config,
    scopes: raw.scopes,
    egress: toEgress(raw.egress),
    operations: raw.operations,
    configurationFields: raw.connection_configuration_fields.map((field) => ({
      ...field,
      label: field.name
        .replaceAll("_", " ")
        .replace(/^./, (letter) => letter.toUpperCase()),
    })),
  };
}

function toBinding(value: unknown): Binding {
  const raw = BindingSchema.parse(value);
  return {
    id: raw.id,
    targetKind: raw.target_kind,
    targetId: raw.target_id,
    targetLabel: raw.target_label,
    createdAt: raw.created_at,
  };
}

function toConnection(value: unknown): Connection {
  const raw = ConnectionSchema.parse(value);
  return {
    connectionId: raw.connection_id,
    connectionRef: raw.connection_ref,
    logicalName: raw.logical_name,
    displayName: raw.display_name,
    providerId: raw.provider_id,
    status: raw.status,
    statusDetail: raw.status_detail,
    organizationId: raw.organization_id,
    projectId: raw.project_id,
    ownerKind: raw.owner_kind,
    shareability: raw.shareability,
    requestedScopes: raw.requested_scopes,
    grantedScopes: raw.granted_scopes,
    accountLabel: raw.account_label,
    expiresAt: raw.expires_at,
    refreshable: raw.refreshable,
    lastRefreshedAt: raw.last_refreshed_at,
    maxInvokeLevel: raw.max_invoke_level,
    egress: toEgress(raw.egress),
    bindings: raw.bindings.map(toBinding),
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
  };
}

function toEvent(value: unknown): ConnectionEvent {
  const raw = ConnectionEventSchema.parse(value);
  return {
    id: raw.id,
    kind: raw.kind,
    at: raw.at,
    detail: raw.detail,
  };
}

/* --------------------------------------------------------------- requests */

export function listProviders(): Promise<Provider[]> {
  return call("/providers", {}, (body) =>
    ListProvidersResponseSchema.parse(body).providers.map(toProvider),
  );
}

export function listConnections(): Promise<Connection[]> {
  return call("/connections", {}, (body) =>
    ListConnectionsResponseSchema.parse(body).connections.map(toConnection),
  );
}

export function discoverConnections(): Promise<number> {
  return call(
    "/connections/discover",
    { method: "POST" },
    (body) => DiscoverConnectionsResponseSchema.parse(body).configured,
  );
}

export function getConnection(id: string): Promise<Connection> {
  return call(`/connections/${encodeURIComponent(id)}`, {}, toConnection);
}

export function createConnection(body: {
  providerId: string;
  displayName?: string;
  scopes?: string[];
  projectId?: string;
}): Promise<Connection> {
  return call(
    "/connections",
    {
      method: "POST",
      body: JSON.stringify({
        provider_id: body.providerId,
        ...(body.displayName ? { display_name: body.displayName } : {}),
        ...(body.scopes ? { scopes: body.scopes } : {}),
        ...(body.projectId ? { project_id: body.projectId } : {}),
      }),
    },
    toConnection,
  );
}

export function authorizeConnection(
  id: string,
  scopes?: string[],
): Promise<{ authorizationUrl: string; expiresAt: string }> {
  return call(
    `/connections/${encodeURIComponent(id)}/authorize`,
    {
      method: "POST",
      body: JSON.stringify(scopes ? { scopes } : {}),
    },
    (body) => {
      const parsed = AuthorizeResponseSchema.parse(body);
      return {
        authorizationUrl: parsed.authorization_url,
        expiresAt: parsed.expires_at,
      };
    },
  );
}

export function refreshConnection(id: string): Promise<Connection> {
  return call(
    `/connections/${encodeURIComponent(id)}/refresh`,
    { method: "POST" },
    toConnection,
  );
}

export function setConnectionCredential(
  id: string,
  value: string,
): Promise<Connection> {
  return call(
    `/connections/${encodeURIComponent(id)}/credential`,
    { method: "POST", body: JSON.stringify({ value }) },
    toConnection,
  );
}

export function setConnectionConfiguration(
  id: string,
  configurationSet: Record<string, string>,
  configurationClear: string[] = [],
): Promise<Connection> {
  return call(
    `/connections/${encodeURIComponent(id)}/credential`,
    {
      method: "POST",
      body: JSON.stringify({
        configuration_set: configurationSet,
        configuration_clear: configurationClear,
      }),
    },
    toConnection,
  );
}

export function revokeConnection(id: string): Promise<{
  revoked: boolean;
  providerRevocation: "ok" | "unsupported" | "failed";
}> {
  return call(
    `/connections/${encodeURIComponent(id)}`,
    { method: "DELETE" },
    (body) => {
      const parsed = RevokeResponseSchema.parse(body);
      return {
        revoked: parsed.revoked,
        providerRevocation: parsed.provider_revocation,
      };
    },
  );
}

export function updateConnectionPolicy(
  id: string,
  body: { shareability: Connection["shareability"]; maxInvokeLevel: 1 | 2 },
): Promise<Connection> {
  return call(
    `/connections/${encodeURIComponent(id)}`,
    {
      method: "PATCH",
      body: JSON.stringify({
        shareability: body.shareability,
        max_invoke_level: body.maxInvokeLevel,
      }),
    },
    toConnection,
  );
}

export function bindConnection(
  id: string,
  body: {
    targetKind: BindingTargetKind;
    targetId: string;
    targetLabel?: string;
  },
): Promise<Connection> {
  return call(
    `/connections/${encodeURIComponent(id)}/bindings`,
    {
      method: "POST",
      body: JSON.stringify({
        target_kind: body.targetKind,
        target_id: body.targetId,
        ...(body.targetLabel ? { target_label: body.targetLabel } : {}),
      }),
    },
    toConnection,
  );
}

export function unbindConnection(
  id: string,
  bindingId: string,
): Promise<Connection> {
  return call(
    `/connections/${encodeURIComponent(id)}/bindings/${encodeURIComponent(bindingId)}`,
    { method: "DELETE" },
    toConnection,
  );
}

export function connectionEvents(id: string): Promise<ConnectionEvent[]> {
  return call(`/connections/${encodeURIComponent(id)}/events`, {}, (body) =>
    ListEventsResponseSchema.parse(body).events.map(toEvent),
  );
}

/* ----------------------------------------------------------- consent flow */

export type ConsentOutcome =
  | { result: "active"; connection: Connection }
  | { result: "failed"; connection: Connection }
  | { result: "abandoned" };

const POLL_MS = 1500;
/** Long enough for a real consent screen including an upstream login and MFA. */
const CONSENT_TIMEOUT_MS = 5 * 60_000;

/**
 * Run the consent round trip. The popup posts back on success, but a blocked
 * `postMessage`, a popup the user closed by hand, or a provider that lands on
 * its own page instead of ours would all strand the flow — so the connection
 * is polled as well, and whichever settles first wins.
 */
export async function awaitConsent(
  connectionId: string,
  popup: Window | null,
  signal?: AbortSignal,
): Promise<ConsentOutcome> {
  const origin = new URL(base()).origin;
  const deadline = Date.now() + CONSENT_TIMEOUT_MS;

  let settled = false;
  let onMessage: ((event: MessageEvent) => void) | null = null;

  const messaged = new Promise<void>((resolve) => {
    onMessage = (event: MessageEvent) => {
      if (event.origin !== origin) return;
      const data = obj(event.data);
      if (data.type !== "opensesame:connection") return;
      if (data.connectionId !== connectionId) return;
      resolve();
    };
    window.addEventListener("message", onMessage);
  });

  try {
    while (!settled) {
      if (signal?.aborted) return { result: "abandoned" };
      if (Date.now() > deadline) return { result: "abandoned" };

      await Promise.race([messaged, sleep(POLL_MS)]);

      const connection = await getConnection(connectionId).catch(() => null);
      if (connection && connection.status !== "pending") {
        settled = true;
        return connection.status === "active"
          ? { result: "active", connection }
          : { result: "failed", connection };
      }

      // A closed popup with the connection still pending means the user backed
      // out. Give the callback one more poll to land before saying so.
      if (popup?.closed) {
        await sleep(POLL_MS);
        const last = await getConnection(connectionId).catch(() => null);
        if (last && last.status !== "pending") {
          return last.status === "active"
            ? { result: "active", connection: last }
            : { result: "failed", connection: last };
        }
        return { result: "abandoned" };
      }
    }
    return { result: "abandoned" };
  } finally {
    if (onMessage) window.removeEventListener("message", onMessage);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function openConsentPopup(url: string): Window | null {
  return window.open(
    url,
    "opensesame-connect",
    "width=680,height=820,noopener=no,noreferrer=no",
  );
}
