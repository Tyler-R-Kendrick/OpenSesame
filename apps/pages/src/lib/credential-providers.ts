import { hostFetch } from "./organization-identity.js";
import { loadSettings } from "./settings.js";

export type Provider = {
  id: string;
  displayName: string;
  categories: string[];
  capabilities: string[];
  authentication: string[];
  executionTargets: string[];
  support: "experimental" | "contract_tested" | "supported";
  adapter: string;
};

export type Connection = {
  id: string;
  providerId: string;
  displayName: string;
  publicConfig: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

async function call<T>(
  organizationId: string,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const response = await hostFetch(organizationId, `/api/v1${path}`, init);
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as {
      error?: string;
      detail?: string;
    };
    throw new Error(
      body.detail ?? body.error ?? `Host request failed (${response.status}).`,
    );
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

function provider(value: Record<string, unknown>): Provider {
  return {
    id: String(value.id ?? ""),
    displayName: String(value.display_name ?? value.id ?? ""),
    categories: Array.isArray(value.categories)
      ? value.categories.map(String)
      : [],
    capabilities: Array.isArray(value.capabilities)
      ? value.capabilities.map(String)
      : [],
    authentication: Array.isArray(value.authentication)
      ? value.authentication.map(String)
      : [],
    executionTargets: Array.isArray(value.execution_targets)
      ? value.execution_targets.map(String)
      : [],
    support: (value.support as Provider["support"]) ?? "experimental",
    adapter: String(value.adapter ?? ""),
  };
}

function connection(value: Record<string, unknown>): Connection {
  return {
    id: String(value.id ?? ""),
    providerId: String(value.provider_id ?? ""),
    displayName: String(value.display_name ?? ""),
    publicConfig:
      value.public_config && typeof value.public_config === "object"
        ? (value.public_config as Record<string, unknown>)
        : {},
    createdAt: String(value.created_at ?? ""),
    updatedAt: String(value.updated_at ?? ""),
  };
}

export async function listProviders(): Promise<Provider[]> {
  const host = loadSettings().hostApi.replace(/\/$/, "");
  const response = await fetch(`${host}/api/v1/credential-providers`, {
    credentials: "omit",
  });
  if (!response.ok) {
    throw new Error(`Host request failed (${response.status}).`);
  }
  const body = (await response.json()) as {
    providers?: Array<Record<string, unknown>>;
  };
  return (body.providers ?? []).map(provider);
}

export async function listConnections(
  organizationId: string,
): Promise<Connection[]> {
  const body = await call<{ connections?: Array<Record<string, unknown>> }>(
    organizationId,
    "/credential-connections",
  );
  return (body.connections ?? []).map(connection);
}

export async function createConnection(input: {
  organizationId: string;
  providerId: string;
  displayName: string;
  publicConfig: Record<string, unknown>;
}): Promise<Connection> {
  const body = await call<Record<string, unknown>>(
    input.organizationId,
    "/credential-connections",
    {
      method: "POST",
      body: JSON.stringify({
        provider_id: input.providerId,
        display_name: input.displayName,
        public_config: input.publicConfig,
      }),
    },
  );
  return connection(body);
}

export async function removeConnection(
  organizationId: string,
  id: string,
): Promise<void> {
  await call(
    organizationId,
    `/credential-connections/${encodeURIComponent(id)}`,
    { method: "DELETE" },
  );
}

export async function updateConnection(
  organizationId: string,
  id: string,
  input: { displayName: string; publicConfig: Record<string, unknown> },
): Promise<Connection> {
  const body = await call<Record<string, unknown>>(
    organizationId,
    `/credential-connections/${encodeURIComponent(id)}`,
    {
      method: "PUT",
      body: JSON.stringify({
        display_name: input.displayName,
        public_config: input.publicConfig,
      }),
    },
  );
  return connection(body);
}

export function testProvider(
  organizationId: string,
  id: string,
): Promise<{
  available: boolean;
  live: boolean;
  detail: unknown;
}> {
  return call(
    organizationId,
    `/credential-providers/${encodeURIComponent(id)}/test`,
    { method: "POST" },
  );
}
