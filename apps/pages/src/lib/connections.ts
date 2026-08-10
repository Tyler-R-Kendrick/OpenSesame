import {
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

function nullableString(value: unknown) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function stringList(value: unknown) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function list(value: unknown, key: string) {
  const raw = object(value)[key];
  return Array.isArray(raw) ? raw : [];
}

const PROVIDER_CATEGORIES = new Set<ProviderCategory>([
  "developer",
  "productivity",
  "communication",
  "storage",
  "crm",
  "payments",
  "identity",
  "testing",
]);

function providerCategory(value: unknown): ProviderCategory | null {
  return typeof value === "string" &&
    PROVIDER_CATEGORIES.has(value as ProviderCategory)
    ? (value as ProviderCategory)
    : null;
}

function authKind(value: unknown): AuthKind | null {
  return value === "oauth2_authorization_code" || value === "api_key"
    ? value
    : null;
}

function integrationSource(value: unknown): Integration["source"] | null {
  return value === "organization" ||
    value === "shared_dev" ||
    value === "deployment"
    ? value
    : null;
}

export function parseProviderList(value: unknown): Provider[] {
  return list(value, "providers").flatMap((entry) => {
    const raw = object(entry);
    const id = string(raw.id);
    const category = providerCategory(raw.category);
    const kind = authKind(raw.auth_kind);
    if (!id || !category || !kind) return [];
    return [
      {
        id,
        displayName: string(raw.display_name, id),
        category,
        docsUrl: string(raw.docs_url),
        authKind: kind,
        callbackUrl: nullableString(raw.callback_url),
        scopes: Array.isArray(raw.scopes)
          ? raw.scopes.map((scope) => {
              const parsed = object(scope);
              return {
                name: string(parsed.name),
                description: string(parsed.description),
                sensitive: parsed.sensitive === true,
                default: parsed.default === true,
              };
            })
          : [],
      },
    ];
  });
}

export function parseIntegrationList(value: unknown): Integration[] {
  return list(value, "integrations").flatMap((entry) => {
    const raw = object(entry);
    const id = string(raw.id);
    const providerId = string(raw.provider_id);
    const source = integrationSource(raw.source);
    if (!id || !providerId || !source) return [];
    return [
      {
        id,
        key: string(raw.key, id),
        providerId,
        displayName: string(raw.display_name, providerId),
        source,
        enabled: raw.enabled === true,
        configured: raw.configured === true,
        scopes: stringList(raw.scopes),
        clientIdHint: nullableString(raw.client_id_hint),
        hasClientSecret: raw.has_client_secret === true,
        connectionCount:
          typeof raw.connection_count === "number" ? raw.connection_count : 0,
        callbackUrl: nullableString(raw.callback_url),
      },
    ];
  });
}

export function parseConnectionList(value: unknown): Connection[] {
  return list(value, "connections").flatMap((entry) => {
    const raw = object(entry);
    const id = string(raw.connection_id, string(raw.id));
    const integrationId = nullableString(raw.integration_id);
    if (!id) return [];
    return [
      {
        id,
        integrationId,
        providerId: string(raw.provider_id),
        displayName: string(raw.display_name, string(raw.logical_name, id)),
        accountLabel: nullableString(raw.account_label),
        status: string(raw.status, "pending"),
        scopes: stringList(raw.granted_scopes).length
          ? stringList(raw.granted_scopes)
          : stringList(raw.requested_scopes),
        refreshable: raw.refreshable === true,
      },
    ];
  });
}

export function parseMemberList(value: unknown): OrganizationMember[] {
  return list(value, "members").flatMap((entry) => {
    const raw = object(entry);
    const principalId = string(raw.principalId, string(raw.principal_id));
    const role = raw.role;
    if (
      !principalId ||
      (role !== "owner" && role !== "admin" && role !== "member")
    ) {
      return [];
    }
    return [{ principalId, role }];
  });
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
    (body) => parseIntegrationList({ integrations: [body] })[0],
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
    (body) => parseIntegrationList({ integrations: [body] })[0],
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
    (body) => parseConnectionList({ connections: [body] })[0],
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
    (body) => {
      const raw = object(body);
      const authorizationUrl = string(raw.authorization_url);
      if (!authorizationUrl) throw new Error("Host omitted authorization URL.");
      return authorizationUrl;
    },
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
    (body) => parseConnectionList({ connections: [body] })[0],
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
    (body) => parseConnectionList({ connections: [body] })[0],
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
    (body) => parseMemberList({ members: [body] })[0],
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
    (body) => parseMemberList({ members: [body] })[0],
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
      string(
        raw.hint,
        string(raw.message, string(raw.error, "Request failed.")),
      ),
    );
  }
  return parse(body);
}
