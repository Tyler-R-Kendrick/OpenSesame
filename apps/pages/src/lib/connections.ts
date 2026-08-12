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

export type BindingTargetKind = "organization" | "project" | "agent";

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
  shareability: string;
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
    throw new ConnectionsError(
      res.status,
      readString(body, "error") ?? "unknown_error",
      readString(body, "hint") ??
        readString(body, "message") ??
        `Request failed (${res.status}).`,
    );
  }
  if (res.status === 204) return map(null);
  return map(await res.json());
}

/* ----------------------------------------------------------- wire mapping */

function readString(body: unknown, key: string): string | null {
  if (!body || typeof body !== "object") return null;
  const value = (body as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim() ? value : null;
}

function obj(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

function str(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function orNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function strList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v) => typeof v === "string") : [];
}

function toEgress(value: unknown): Egress {
  const raw = obj(value);
  return {
    scheme: str(raw.scheme, "https"),
    authorities: strList(raw.authorities),
    pathPrefixes: strList(raw.path_prefixes),
  };
}

function toProvider(value: unknown): Provider {
  const raw = obj(value);
  return {
    id: str(raw.id),
    displayName: str(raw.display_name, str(raw.id)),
    category:
      (str(raw.category, "developer") as ProviderCategory) ?? "developer",
    docsUrl: str(raw.docs_url),
    authKind: str(raw.auth_kind, "oauth2_authorization_code") as AuthKind,
    supportsRefresh: raw.supports_refresh === true,
    configured: raw.configured === true,
    missingConfig: strList(raw.missing_config),
    scopes: Array.isArray(raw.scopes)
      ? raw.scopes.map((scope) => {
          const s = obj(scope);
          return {
            name: str(s.name),
            description: str(s.description),
            sensitive: s.sensitive === true,
            default: s.default === true,
          };
        })
      : [],
    egress: toEgress(raw.egress),
    operations: strList(raw.operations),
    configurationFields: Array.isArray(raw.configuration_fields)
      ? raw.configuration_fields.map((field) => {
          const item = obj(field);
          return {
            name: str(item.name),
            label: str(item.label, str(item.name)),
            secret: item.secret === true,
            required: item.required === true,
          };
        })
      : [],
  };
}

function toBinding(value: unknown): Binding {
  const raw = obj(value);
  return {
    id: str(raw.id),
    targetKind: str(raw.target_kind, "project") as BindingTargetKind,
    targetId: str(raw.target_id),
    targetLabel: orNull(raw.target_label),
    createdAt: str(raw.created_at),
  };
}

function toConnection(value: unknown): Connection {
  const raw = obj(value);
  return {
    connectionId: str(raw.connection_id),
    connectionRef: str(raw.connection_ref),
    logicalName: str(raw.logical_name),
    displayName: str(raw.display_name, str(raw.logical_name)),
    providerId: str(raw.provider_id),
    status: str(raw.status, "error") as ConnectionStatus,
    statusDetail: orNull(raw.status_detail),
    organizationId: str(raw.organization_id),
    projectId: orNull(raw.project_id),
    ownerKind: str(raw.owner_kind, "organization"),
    shareability: str(raw.shareability, "private"),
    requestedScopes: strList(raw.requested_scopes),
    grantedScopes: strList(raw.granted_scopes),
    accountLabel: orNull(raw.account_label),
    expiresAt: orNull(raw.expires_at),
    refreshable: raw.refreshable === true,
    lastRefreshedAt: orNull(raw.last_refreshed_at),
    maxInvokeLevel:
      typeof raw.max_invoke_level === "number" ? raw.max_invoke_level : 1,
    egress: toEgress(raw.egress),
    bindings: Array.isArray(raw.bindings) ? raw.bindings.map(toBinding) : [],
    createdAt: str(raw.created_at),
    updatedAt: str(raw.updated_at),
  };
}

function toEvent(value: unknown): ConnectionEvent {
  const raw = obj(value);
  return {
    id: str(raw.id),
    kind: str(raw.kind, "error") as ConnectionEventKind,
    at: str(raw.at),
    detail: orNull(raw.detail),
  };
}

function listOf<T>(key: string, map: (value: unknown) => T) {
  return (body: unknown): T[] => {
    const raw = obj(body)[key];
    return Array.isArray(raw) ? raw.map(map) : [];
  };
}

/* --------------------------------------------------------------- requests */

export function listProviders(): Promise<Provider[]> {
  return fetch(`${base()}/api/v1/providers`, { credentials: "omit" })
    .then(async (response) => {
      if (!response.ok) {
        throw new ConnectionsError(
          response.status,
          "catalog_unavailable",
          `Provider catalog failed (${response.status}).`,
        );
      }
      return response.json();
    })
    .then(listOf("providers", toProvider))
    .catch((error) => {
      if (error instanceof ConnectionsError) throw error;
      throw new ConnectionsError(
        0,
        "unreachable",
        `Host API unreachable at ${base()}.`,
      );
    });
}

export function listConnections(): Promise<Connection[]> {
  return call("/connections", {}, listOf("connections", toConnection));
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
    (body) => ({
      authorizationUrl: str(obj(body).authorization_url),
      expiresAt: str(obj(body).expires_at),
    }),
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

export function revokeConnection(id: string): Promise<void> {
  return call(`/connections/${encodeURIComponent(id)}`, { method: "DELETE" });
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
  return call(
    `/connections/${encodeURIComponent(id)}/events`,
    {},
    listOf("events", toEvent),
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
