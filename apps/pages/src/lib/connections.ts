import {
  AuthorizeResponseSchema,
  ConnectionSchema,
  IntegrationSchema,
  ListConnectionsResponseSchema,
  ListIntegrationsResponseSchema,
  ListProvidersResponseSchema,
  OrganizationMembershipResponseSchema,
} from "@opensesame/contracts";
import {
  IDENTITY_COOKIE_RECOVERY,
  type OrganizationRole,
  type SessionOrganization,
  hostFetch,
  identityFetch,
} from "./identity.js";

export type ProviderCategory =
  | "developer"
  | "productivity"
  | "communication"
  | "storage"
  | "crm"
  | "payments"
  | "identity"
  | "testing";

export type AuthKind = "oauth2_authorization_code" | "api_key";

export type ProviderScope = {
  name: string;
  description: string;
  sensitive: boolean;
  default: boolean;
};

export type Provider = {
  id: string;
  displayName: string;
  category: ProviderCategory;
  docsUrl: string;
  authKind: AuthKind;
  callbackUrl: string | null;
  scopes: ProviderScope[];
};

export type Integration = {
  id: string;
  key: string;
  providerId: string;
  displayName: string;
  source: "organization" | "shared_dev" | "deployment";
  enabled: boolean;
  configured: boolean;
  scopes: string[];
  clientIdHint: string | null;
  hasClientSecret: boolean;
  connectionCount: number;
  callbackUrl: string | null;
};

export type Connection = {
  id: string;
  integrationId: string | null;
  providerId: string;
  displayName: string;
  accountLabel: string | null;
  status: string;
  scopes: string[];
  refreshable: boolean;
};

export type OrganizationMember = {
  principalId: string;
  role: OrganizationRole;
};

export class ConnectionsError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ConnectionsError";
  }
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

function string(value: unknown, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

const StrictMembershipSchema = OrganizationMembershipResponseSchema.strict();

function strictList(value: unknown, key: string): unknown[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid ${key} response.`);
  }
  const raw = value as Record<string, unknown>;
  if (
    Object.keys(raw).length !== 1 ||
    !Object.hasOwn(raw, key) ||
    !Array.isArray(raw[key])
  ) {
    throw new Error(`Invalid ${key} response.`);
  }
  return raw[key];
}

export function parseProviderList(value: unknown): Provider[] {
  return ListProvidersResponseSchema.parse(value).providers.map((raw) => ({
    id: raw.id,
    displayName: raw.display_name,
    category: raw.category,
    docsUrl: raw.docs_url,
    authKind: raw.auth_kind,
    callbackUrl: raw.callback_url,
    scopes: raw.scopes,
  }));
}

export function parseIntegrationList(value: unknown): Integration[] {
  return ListIntegrationsResponseSchema.parse(value).integrations.map((raw) =>
    mapIntegration(raw),
  );
}

export function parseConnectionList(value: unknown): Connection[] {
  return ListConnectionsResponseSchema.parse(value).connections.map((raw) =>
    mapConnection(raw),
  );
}

export function parseMemberList(value: unknown): OrganizationMember[] {
  return strictList(value, "members").map((entry) => {
    const raw = StrictMembershipSchema.parse(entry);
    return { principalId: raw.principalId, role: raw.role };
  });
}

function mapIntegration(raw: ReturnType<typeof IntegrationSchema.parse>) {
  return {
    id: raw.id,
    key: raw.key,
    providerId: raw.provider_id,
    displayName: raw.display_name,
    source: raw.source,
    enabled: raw.enabled,
    configured: raw.configured,
    scopes: raw.scopes,
    clientIdHint: raw.client_id_hint,
    hasClientSecret: raw.has_client_secret,
    connectionCount: raw.connection_count,
    callbackUrl: raw.callback_url,
  } satisfies Integration;
}

function mapConnection(raw: ReturnType<typeof ConnectionSchema.parse>) {
  return {
    id: raw.connection_id,
    integrationId: raw.integration_id,
    providerId: raw.provider_id,
    displayName: raw.display_name || raw.logical_name,
    accountLabel: raw.account_label,
    status: raw.status,
    scopes: raw.granted_scopes.length
      ? raw.granted_scopes
      : raw.requested_scopes,
    refreshable: raw.refreshable,
  } satisfies Connection;
}

export function chooseOrganization(
  organizations: SessionOrganization[],
  currentId: string | null,
) {
  if (currentId && organizations.some((org) => org.id === currentId)) {
    return currentId;
  }
  return organizations.length === 1 ? organizations[0].id : null;
}

async function request<T>(
  organizationId: string,
  path: string,
  init: RequestInit,
  parse: (value: unknown) => T,
) {
  const response = await hostFetch(organizationId, `/api/v1${path}`, init);
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const raw = object(body);
    throw new ConnectionsError(
      response.status,
      string(
        raw.hint,
        string(raw.message, string(raw.error, "Request failed.")),
      ),
    );
  }
  return parse(body);
}

export function listProviders(organizationId: string) {
  return request(organizationId, "/providers", {}, parseProviderList);
}

export function listIntegrations(organizationId: string) {
  return request(organizationId, "/integrations", {}, parseIntegrationList);
}

export function listConnections(organizationId: string) {
  return request(organizationId, "/connections", {}, parseConnectionList);
}

export function listMembers(organizationId: string) {
  return identityRequest(
    `/v1/organizations/${encodeURIComponent(organizationId)}/members`,
    {},
    parseMemberList,
  );
}

export function createIntegration(
  organizationId: string,
  input: {
    key: string;
    providerId: string;
    displayName: string;
    clientId: string;
    clientSecret: string;
    scopes: string[];
  },
) {
  return request(
    organizationId,
    "/integrations",
    {
      method: "POST",
      body: JSON.stringify({
        key: input.key,
        provider_id: input.providerId,
        display_name: input.displayName,
        ...(input.clientId ? { client_id: input.clientId } : {}),
        ...(input.clientSecret ? { client_secret: input.clientSecret } : {}),
        scopes: input.scopes,
      }),
    },
    (body) => mapIntegration(IntegrationSchema.parse(body)),
  );
}

export function updateIntegration(
  organizationId: string,
  integrationId: string,
  input: Record<string, unknown>,
) {
  return request(
    organizationId,
    `/integrations/${encodeURIComponent(integrationId)}`,
    { method: "PATCH", body: JSON.stringify(input) },
    (body) => mapIntegration(IntegrationSchema.parse(body)),
  );
}

export async function deleteIntegration(
  organizationId: string,
  integrationId: string,
) {
  await request(
    organizationId,
    `/integrations/${encodeURIComponent(integrationId)}`,
    { method: "DELETE" },
    () => undefined,
  );
}

export function createConnection(
  organizationId: string,
  input: { integrationId: string; displayName: string; scopes: string[] },
) {
  return request(
    organizationId,
    "/connections",
    {
      method: "POST",
      body: JSON.stringify({
        integration_id: input.integrationId,
        display_name: input.displayName,
        scopes: input.scopes,
      }),
    },
    (body) => mapConnection(ConnectionSchema.parse(body)),
  );
}

export function authorizeConnection(
  organizationId: string,
  connectionId: string,
) {
  return request(
    organizationId,
    `/connections/${encodeURIComponent(connectionId)}/authorize`,
    { method: "POST", body: "{}" },
    (body) => AuthorizeResponseSchema.parse(body).authorization_url,
  );
}

export function setConnectionCredential(
  organizationId: string,
  connectionId: string,
  value: string,
) {
  return request(
    organizationId,
    `/connections/${encodeURIComponent(connectionId)}/credential`,
    { method: "POST", body: JSON.stringify({ value }) },
    (body) => mapConnection(ConnectionSchema.parse(body)),
  );
}

export function refreshConnection(
  organizationId: string,
  connectionId: string,
) {
  return request(
    organizationId,
    `/connections/${encodeURIComponent(connectionId)}/refresh`,
    { method: "POST" },
    (body) => mapConnection(ConnectionSchema.parse(body)),
  );
}

export async function revokeConnection(
  organizationId: string,
  connectionId: string,
) {
  await request(
    organizationId,
    `/connections/${encodeURIComponent(connectionId)}`,
    { method: "DELETE" },
    () => undefined,
  );
}

export function addMember(
  organizationId: string,
  principalId: string,
  role: OrganizationRole,
) {
  return identityRequest(
    `/v1/organizations/${encodeURIComponent(organizationId)}/members`,
    {
      method: "POST",
      body: JSON.stringify({ principalId, role }),
    },
    (body) => {
      const member = StrictMembershipSchema.parse(body);
      return { principalId: member.principalId, role: member.role };
    },
  );
}

export function updateMember(
  organizationId: string,
  principalId: string,
  role: OrganizationRole,
) {
  return identityRequest(
    `/v1/organizations/${encodeURIComponent(organizationId)}/members/${encodeURIComponent(principalId)}`,
    { method: "PATCH", body: JSON.stringify({ role }) },
    (body) => {
      const member = StrictMembershipSchema.parse(body);
      return { principalId: member.principalId, role: member.role };
    },
  );
}

export async function removeMember(
  organizationId: string,
  principalId: string,
) {
  await identityRequest(
    `/v1/organizations/${encodeURIComponent(organizationId)}/members/${encodeURIComponent(principalId)}`,
    { method: "DELETE" },
    () => undefined,
  );
}

async function identityRequest<T>(
  path: string,
  init: RequestInit,
  parse: (value: unknown) => T,
) {
  const response = await identityFetch(path, init);
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const raw = object(body);
    throw new ConnectionsError(
      response.status,
      response.status === 401
        ? IDENTITY_COOKIE_RECOVERY
        : string(
            raw.hint,
            string(raw.message, string(raw.error, "Request failed.")),
          ),
    );
  }
  return parse(body);
}
