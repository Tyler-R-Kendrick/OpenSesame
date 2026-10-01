import {
  AuthorizeResponseSchema,
  BindingSchema,
  ConnectionErrorResponseSchema,
  ConnectionSchema,
  DiscoverConnectionsResponseSchema,
  ListConnectionsResponseSchema,
  ListProvidersResponseSchema,
  RevokeResponseSchema,
} from "@opensesame/contracts";
import {
  type BoundaryValue,
  type JsonObject,
  isTypeofObject,
  overlapCast,
} from "@opensesame/os-domain";
import { page } from "../ports.js";
import {
  noteConnectionCreated,
  noteConnectionRevoked,
} from "./activity-log.js";
import { ConnectionsError } from "./connections-error.js";
import {
  type Integration,
  integrationFromLocal,
  toIntegration,
} from "./connections-integrations.js";
import { revokeLocalGitConnection } from "./connections-local-git.js";
import { providerFromView } from "./connector-catalog.js";
import {
  connectionCreateJson,
  createHostOrDevice,
  deviceConnection,
  mergeOfflineConnections,
  noteExternalConnectorUse,
  revokeDeviceConnection,
  sealDeviceConfiguration,
  sealDeviceCredential,
} from "./device-connectors.js";
import {
  buildGithubAppRegistration,
  readLocalGithubApp,
} from "./github-app-manifest.js";
import { claimGuestConnection } from "./guest-connections.js";
import { isGuestSession } from "./guest-isolation.js";
import { HostSessionError, hostBase, hostFetch } from "./identity.js";
import * as vercelConnect from "./vercel-connect-ops.js";

export type { Integration } from "./connections-integrations.js";
export { ConnectionsError };

export type ProviderCategory =
  | "identity"
  | "backup_recovery"
  | "encryption"
  | "password_managers"
  | "agent_harnesses"
  | "networking"
  | "wallet"
  | "cloud_secret_storage"
  | "local_storage"
  | "developer"
  | "productivity"
  | "communication"
  | "storage"
  | "crm"
  | "testing"
  | "certificates"
  | "custom";
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
  /** Host OAuth callback URL for this provider, when applicable. */
  callbackUrl: string | null;
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

export type Connection = {
  connectionId: string;
  connectionRef: string;
  logicalName: string;
  displayName: string;
  providerId: string;
  /** Tenant integration that sealed this connection's OAuth/App credentials. */
  integrationId: string | null;
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

function base(): string {
  return hostBase();
}

async function call<T>(
  path: string,
  init: RequestInit = {},
  map: (body: BoundaryValue) => T = (body) => overlapCast(body),
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
    if (!(error instanceof HostSessionError || error instanceof TypeError))
      throw error;
    throw new ConnectionsError(0, "unreachable", error.message);
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

function obj(value: BoundaryValue): JsonObject {
  return value && isTypeofObject(value) ? overlapCast(value) : {};
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

function toBinding(value: BoundaryValue): Binding {
  const raw = BindingSchema.parse(value);
  return {
    id: raw.id,
    targetKind: raw.target_kind,
    targetId: raw.target_id,
    targetLabel: raw.target_label,
    createdAt: raw.created_at,
  };
}

function toConnection(value: BoundaryValue): Connection {
  const raw = ConnectionSchema.parse(value);
  return {
    connectionId: raw.connection_id,
    connectionRef: raw.connection_ref,
    logicalName: raw.logical_name,
    displayName: raw.display_name,
    providerId: raw.provider_id,
    integrationId: raw.integration_id,
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

/* --------------------------------------------------------------- requests */

export type GithubAppRegistration = {
  action: string;
  state: string;
  manifest: JsonObject;
  redirectUrl: string;
};

function listIntegrationsDefault(): Promise<Integration[]> {
  const local = readLocalGithubApp();
  const localRows = local ? [integrationFromLocal(local)] : [];
  return call("/integrations", {}, (body) => {
    const raw: { integrations?: BoundaryValue[] } = overlapCast(body);
    return (raw.integrations ?? []).map(toIntegration);
  }).then(
    (remote) => [...localRows, ...remote],
    () => localRows,
  );
}
export type CustomProviderAuth =
  | {
      kind: "oauth2_authorization_code";
      authorizeUrl: string;
      tokenUrl: string;
      supportsRefresh: boolean;
      scopes: string[];
    }
  | { kind: "api_key"; header: string; valuePrefix: string };

/** Register an org-scoped custom connector. Owner/admin only. */
function createCustomProviderDefault(body: {
  id: string;
  displayName: string;
  baseUrl: string;
  docsUrl?: string;
  auth: CustomProviderAuth;
}): Promise<Provider> {
  const auth =
    body.auth.kind === "oauth2_authorization_code"
      ? {
          kind: "oauth2_authorization_code",
          authorize_url: body.auth.authorizeUrl,
          token_url: body.auth.tokenUrl,
          supports_refresh: body.auth.supportsRefresh,
          scopes: body.auth.scopes,
        }
      : {
          kind: "api_key",
          header: body.auth.header,
          value_prefix: body.auth.valuePrefix,
        };
  return call(
    "/custom-providers",
    {
      method: "POST",
      body: JSON.stringify({
        id: body.id,
        display_name: body.displayName,
        base_url: body.baseUrl,
        ...(body.docsUrl ? { docs_url: body.docsUrl } : undefined),
        auth,
      }),
    },
    providerFromView,
  );
}

function deleteCustomProviderDefault(id: string): Promise<void> {
  return call(`/custom-providers/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}

/** Seal an org-level OAuth client. Owner/admin only; write-only secret. */
function createIntegrationDefault(body: {
  key: string;
  providerId: string;
  displayName: string;
  scopes?: string[];
  clientId?: string;
  clientSecret?: string;
  configuration?: Record<string, string>;
}): Promise<Integration> {
  return call(
    "/integrations",
    {
      method: "POST",
      body: JSON.stringify({
        key: body.key,
        provider_id: body.providerId,
        display_name: body.displayName,
        scopes: body.scopes ?? [],
        ...(body.clientId ? { client_id: body.clientId } : undefined),
        ...(body.clientSecret
          ? { client_secret: body.clientSecret }
          : undefined),
        ...(body.configuration
          ? { configuration: body.configuration }
          : undefined),
      }),
    },
    toIntegration,
  );
}

function startGithubAppRegistrationDefault(body: {
  returnTo: string;
  displayName?: string;
}): Promise<GithubAppRegistration> {
  return Promise.resolve(buildGithubAppRegistration(body));
}

/** Browser POST to github.com/settings/apps/new (Manifest flow). */
function submitGithubAppManifestDefault(
  registration: GithubAppRegistration,
): void {
  if (!registration.action.startsWith("https://github.com/")) {
    throw new ConnectionsError(
      0,
      "invalid_host",
      "GitHub App registration URL is not github.com — refusing to submit.",
    );
  }
  page().submitForm(
    `${registration.action}?state=${encodeURIComponent(registration.state)}`,
    { manifest: JSON.stringify(registration.manifest) },
    "_self",
  );
}

function listProvidersDefault(): Promise<Provider[]> {
  return call("/providers", {}, (body) =>
    ListProvidersResponseSchema.parse(body).providers.map(providerFromView),
  );
}

function listConnectionsDefault(): Promise<Connection[]> {
  if (vercelConnect.usesConnect()) {
    return vercelConnect.listVercelConnections().then(mergeOfflineConnections);
  }
  return call("/connections", {}, (body) =>
    ListConnectionsResponseSchema.parse(body).connections.map(toConnection),
  )
    .then(mergeOfflineConnections)
    .catch((error) => {
      if (
        error instanceof ConnectionsError &&
        (error.code === "unreachable" || error.status === 0)
      ) {
        return mergeOfflineConnections([]);
      }
      throw error;
    });
}
function discoverConnectionsDefault(): Promise<number> {
  return call(
    "/connections/discover",
    { method: "POST" },
    (body) => DiscoverConnectionsResponseSchema.parse(body).configured,
  );
}
export function getConnection(id: string): Promise<Connection> {
  const local = deviceConnection(id);
  if (local) return Promise.resolve(local);
  if (vercelConnect.isConnectConnector(id))
    return vercelConnect.getVercelConnection(id);
  return call(`/connections/${encodeURIComponent(id)}`, {}, toConnection);
}

function createConnectionDefault(body: {
  providerId: string;
  displayName?: string;
  scopes?: string[];
  projectId?: string;
  integrationId?: string;
}): Promise<Connection> {
  if (vercelConnect.usesConnect(body.providerId))
    return vercelConnect.createVercelConnection(body);
  return createHostOrDevice(body, () =>
    call(
      "/connections",
      { method: "POST", body: connectionCreateJson(body) },
      toConnection,
    ),
  );
}

function authorizeConnectionDefault(
  id: string,
  scopes?: string[],
): Promise<{ authorizationUrl: string; expiresAt: string }> {
  if (vercelConnect.isConnectConnector(id))
    return vercelConnect.authorizeVercelConnection(id, scopes);
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

function refreshConnectionDefault(id: string): Promise<Connection> {
  return call(
    `/connections/${encodeURIComponent(id)}/refresh`,
    { method: "POST" },
    toConnection,
  );
}

function setConnectionCredentialDefault(
  id: string,
  value: string,
): Promise<Connection> {
  const sealed = sealDeviceCredential(id, value);
  if (sealed) return Promise.resolve(sealed);
  return call(
    `/connections/${encodeURIComponent(id)}/credential`,
    { method: "POST", body: JSON.stringify({ value }) },
    toConnection,
  );
}

function setConnectionConfigurationDefault(
  id: string,
  configurationSet: Record<string, string>,
  configurationClear: string[] = [],
): Promise<Connection> {
  const sealed = sealDeviceConfiguration(id, configurationSet);
  if (sealed) return Promise.resolve(sealed);
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

async function revokeConnectionDefault(id: string): Promise<{
  revoked: boolean;
  providerRevocation: "ok" | "unsupported" | "failed";
}> {
  const device = revokeDeviceConnection(id);
  if (device) return device;
  const local = await revokeLocalGitConnection(id);
  if (local) return local;
  if (vercelConnect.isConnectConnector(id))
    return vercelConnect.revokeVercelConnection(id);
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

function updateConnectionPolicyDefault(
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

/* ----------------------------------------------------------- consent flow */

export type ConsentOutcome =
  | { result: "active"; connection: Connection }
  | { result: "failed"; connection: Connection }
  | { result: "abandoned" };

const POLL_MS = 1500;
const CONSENT_TIMEOUT_MS = 5 * 60_000;

async function awaitConsentDefault(
  connectionId: string,
  popup: Window | null,
  signal?: AbortSignal,
): Promise<ConsentOutcome> {
  const origin = new URL(base()).origin;
  const deadline = Date.now() + CONSENT_TIMEOUT_MS;

  let settled = false;
  let sawMessage = false;
  let onMessage: ((event: MessageEvent) => void) | null = null;

  const messaged = new Promise<void>((resolve) => {
    onMessage = (event: MessageEvent) => {
      if (event.origin !== origin) return;
      const data = obj(event.data);
      if (data.type !== "opensesame:connection") return;
      if (data.connectionId !== connectionId) return;
      sawMessage = true;
      resolve();
    };
    page().addEventListener("message", onMessage);
  });

  try {
    while (!settled) {
      if (signal?.aborted) return { result: "abandoned" };
      if (Date.now() > deadline) return { result: "abandoned" };

      if (sawMessage) {
        await sleep(POLL_MS);
      } else {
        await Promise.race([messaged, sleep(POLL_MS)]);
      }

      const connection = await getConnection(connectionId).catch(() => null);
      if (connection && connection.status !== "pending") {
        settled = true;
        return connection.status === "active"
          ? { result: "active", connection }
          : { result: "failed", connection };
      }

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
    if (onMessage) page().removeEventListener("message", onMessage);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function openConsentPopupDefault(url: string): Window | null {
  return page().open(
    url,
    "opensesame-connect",
    "width=680,height=820,noopener=no,noreferrer=no",
  );
}
export const connectionSeams = {
  discoverConnections: discoverConnectionsDefault,
  refreshConnection: refreshConnectionDefault,
  setConnectionConfiguration: setConnectionConfigurationDefault,
  revokeConnection: revokeConnectionDefault,
  updateConnectionPolicy: updateConnectionPolicyDefault,

  listIntegrations: listIntegrationsDefault,
  createIntegration: createIntegrationDefault,
  createCustomProvider: createCustomProviderDefault,
  deleteCustomProvider: deleteCustomProviderDefault,
  startGithubAppRegistration: startGithubAppRegistrationDefault,
  submitGithubAppManifest: submitGithubAppManifestDefault,
  listProviders: listProvidersDefault,
  listConnections: listConnectionsDefault,
  createConnection: createConnectionDefault,
  authorizeConnection: authorizeConnectionDefault,
  setConnectionCredential: setConnectionCredentialDefault,
  awaitConsent: awaitConsentDefault,
  openConsentPopup: openConsentPopupDefault,
};

export function listIntegrations(): Promise<Integration[]> {
  return connectionSeams.listIntegrations();
}
export function createIntegration(
  body: Parameters<typeof createIntegrationDefault>[0],
): Promise<Integration> {
  return connectionSeams.createIntegration(body);
}
export function createCustomProvider(
  body: Parameters<typeof createCustomProviderDefault>[0],
): Promise<Provider> {
  return connectionSeams.createCustomProvider(body);
}
export function deleteCustomProvider(id: string): Promise<void> {
  return connectionSeams.deleteCustomProvider(id);
}
export function startGithubAppRegistration(
  body: Parameters<typeof startGithubAppRegistrationDefault>[0],
): Promise<GithubAppRegistration> {
  return connectionSeams.startGithubAppRegistration(body);
}
export function submitGithubAppManifest(
  ...args: Parameters<typeof submitGithubAppManifestDefault>
): ReturnType<typeof submitGithubAppManifestDefault> {
  return connectionSeams.submitGithubAppManifest(...args);
}
export function listProviders(): Promise<Provider[]> {
  return connectionSeams.listProviders();
}
export function listConnections(): Promise<Connection[]> {
  noteExternalConnectorUse();
  return connectionSeams.listConnections();
}
export async function createConnection(
  body: Parameters<typeof createConnectionDefault>[0],
): Promise<Connection> {
  const created = await connectionSeams.createConnection(body);
  if (isGuestSession()) claimGuestConnection(created.connectionId);
  noteConnectionCreated(created.connectionId);
  return created;
}
export function authorizeConnection(
  ...args: Parameters<typeof authorizeConnectionDefault>
): ReturnType<typeof authorizeConnectionDefault> {
  return connectionSeams.authorizeConnection(...args);
}
export function setConnectionCredential(
  ...args: Parameters<typeof setConnectionCredentialDefault>
): ReturnType<typeof setConnectionCredentialDefault> {
  return connectionSeams.setConnectionCredential(...args);
}
export async function awaitConsent(
  ...args: Parameters<typeof awaitConsentDefault>
): ReturnType<typeof awaitConsentDefault> {
  return connectionSeams.awaitConsent(...args);
}
export function openConsentPopup(url: string): Window | null {
  return connectionSeams.openConsentPopup(url);
}
export function discoverConnections(): Promise<number> {
  return connectionSeams.discoverConnections();
}
export function refreshConnection(id: string): Promise<Connection> {
  return connectionSeams.refreshConnection(id);
}
export function setConnectionConfiguration(
  ...args: Parameters<typeof setConnectionConfigurationDefault>
): ReturnType<typeof setConnectionConfigurationDefault> {
  return connectionSeams.setConnectionConfiguration(...args);
}
export function revokeConnection(
  id: string,
): ReturnType<typeof revokeConnectionDefault> {
  const result = connectionSeams.revokeConnection(id);
  noteConnectionRevoked(id);
  return result;
}
export function updateConnectionPolicy(
  ...args: Parameters<typeof updateConnectionPolicyDefault>
): ReturnType<typeof updateConnectionPolicyDefault> {
  return connectionSeams.updateConnectionPolicy(...args);
}
