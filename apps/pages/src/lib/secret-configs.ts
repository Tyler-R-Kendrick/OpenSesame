import {
  type BoundaryValue,
  type JsonObject,
  isJsonObject,
  isNumber,
  isString,
  overlapCast,
} from "@opensesame/os-domain";
/**
 * Host project-config secret client (ADR 0052 / WP-12).
 *
 * The one value-carrying request is `putConfigSecrets` (write-only intake).
 * Every response on this surface is metadata: config views, key names,
 * version numbers — never values, and every parsed response is re-checked
 * for credential-shaped fields before it reaches the UI.
 */

import { hostFetch } from "./identity.js";

export type SecretConfigEnvironment =
  | "development"
  | "staging"
  | "production"
  | "custom";

export type SecretConfig = {
  id: string;
  organizationId: string;
  projectId: string;
  slug: string;
  displayName: string;
  environment: SecretConfigEnvironment;
  parentConfigId?: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ConfigKeyMeta = {
  keyName: string;
  version: number;
  updatedAt: string;
};

export type ConfigSecretVersion = {
  version: number;
  deleted: boolean;
  actorId?: string | null;
  createdAt: string;
};

export type ConfigCompareEntry = {
  keyName: string;
  aVersion: number;
  bVersion: number;
};

export type ConfigCompare = {
  onlyInA: string[];
  onlyInB: string[];
  inBoth: ConfigCompareEntry[];
};

const FORBIDDEN_KEYS =
  /^(value|secret|password|token|access_token|refresh_token|plaintext|ciphertext)$/i;
const ENVIRONMENTS = new Set<string>([
  "development",
  "staging",
  "production",
  "custom",
]);

function isEnvironment(value: string): value is SecretConfigEnvironment {
  return ENVIRONMENTS.has(value);
}

function assertNoSecretLeak(value: BoundaryValue, path = "response"): void {
  if (value === null || value === undefined) return;
  if (isString(value)) {
    if (value.length > 64 && /(?:sk_|postgres:\/\/|Bearer\s)/i.test(value)) {
      throw new Error(`${path} may contain secret material`);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) assertNoSecretLeak(item, path);
    return;
  }
  if (isJsonObject(value)) {
    for (const [key, nested] of Object.entries(value)) {
      if (FORBIDDEN_KEYS.test(key)) {
        throw new Error(`${path} contained forbidden key ${key}`);
      }
      assertNoSecretLeak(nested, `${path}.${key}`);
    }
  }
}

function pickString(raw: JsonObject, snake: string, camel: string): string {
  const fromSnake = raw[snake];
  if (isString(fromSnake)) return fromSnake;
  const fromCamel = raw[camel];
  return isString(fromCamel) ? fromCamel : "";
}

function normalizeConfig(raw: JsonObject): SecretConfig {
  const environment = pickString(raw, "environment", "environment");
  const parent = raw.parent_config_id ?? raw.parentConfigId;
  return {
    id: String(raw.id ?? ""),
    organizationId: pickString(raw, "organization_id", "organizationId"),
    projectId: pickString(raw, "project_id", "projectId"),
    slug: String(raw.slug ?? ""),
    displayName: pickString(raw, "display_name", "displayName"),
    environment: isEnvironment(environment) ? environment : "custom",
    parentConfigId: isString(parent) ? parent : null,
    createdAt: pickString(raw, "created_at", "createdAt"),
    updatedAt: pickString(raw, "updated_at", "updatedAt"),
  };
}

function normalizeKeyMeta(raw: JsonObject): ConfigKeyMeta {
  const version = raw.version;
  return {
    keyName: pickString(raw, "key_name", "keyName"),
    version: isNumber(version) ? version : 0,
    updatedAt: pickString(raw, "updated_at", "updatedAt"),
  };
}

function normalizeVersion(raw: JsonObject): ConfigSecretVersion {
  const actor = raw.actor_id ?? raw.actorId;
  return {
    version: isNumber(raw.version) ? raw.version : 0,
    deleted: Boolean(raw.deleted),
    actorId: isString(actor) ? actor : null,
    createdAt: pickString(raw, "created_at", "createdAt"),
  };
}

async function parseJsonResponse(
  res: Response,
  failure: string,
): Promise<JsonObject> {
  if (!res.ok) {
    const err: BoundaryValue = await res.json().catch(() => null);
    const hint = isJsonObject(err) && isString(err.hint) ? err.hint : undefined;
    throw new Error(hint ?? `${failure} (${res.status}).`);
  }
  const body: JsonObject = overlapCast(await res.json());
  assertNoSecretLeak(body);
  return body;
}

function configPath(id: string, suffix = ""): string {
  return `/api/v1/configs/${encodeURIComponent(id)}${suffix}`;
}

async function listSecretConfigsDefault(
  projectId: string,
): Promise<SecretConfig[]> {
  const res = await hostFetch(
    `/api/v1/projects/${encodeURIComponent(projectId)}/configs`,
  );
  const body = await parseJsonResponse(res, "List secret configs failed");
  const rows = Array.isArray(body.configs) ? body.configs : [];
  const configs = rows
    .filter((row): row is JsonObject => isJsonObject(row))
    .map(normalizeConfig);
  assertNoSecretLeak(configs);
  return configs;
}

async function createSecretConfigDefault(
  projectId: string,
  input: {
    slug: string;
    environment: SecretConfigEnvironment;
    displayName?: string;
    parentConfigId?: string;
  },
): Promise<SecretConfig> {
  const res = await hostFetch(
    `/api/v1/projects/${encodeURIComponent(projectId)}/configs`,
    {
      method: "POST",
      body: JSON.stringify({
        slug: input.slug,
        environment: input.environment,
        ...(input.displayName
          ? { display_name: input.displayName }
          : undefined),
        ...(input.parentConfigId
          ? { parent_config_id: input.parentConfigId }
          : undefined),
      }),
    },
  );
  const body = await parseJsonResponse(res, "Create secret config failed");
  return normalizeConfig(body);
}

async function deleteSecretConfigDefault(id: string): Promise<void> {
  const res = await hostFetch(configPath(id), { method: "DELETE" });
  if (!res.ok && res.status !== 204) {
    throw new Error(`Delete secret config failed (${res.status}).`);
  }
}

/**
 * Write-only value intake: values travel on this request and never come back.
 * The response — and everything after it — is key names + versions only.
 */
async function putConfigSecretsDefault(
  configId: string,
  secrets: Record<string, string>,
): Promise<ConfigKeyMeta[]> {
  const res = await hostFetch(configPath(configId, "/secrets"), {
    method: "PUT",
    body: JSON.stringify({ secrets }),
  });
  const body = await parseJsonResponse(res, "Set config secrets failed");
  const keys = (Array.isArray(body.keys) ? body.keys : [])
    .filter((row): row is JsonObject => isJsonObject(row))
    .map(normalizeKeyMeta);
  assertNoSecretLeak(keys);
  return keys;
}

async function listConfigKeysDefault(
  configId: string,
): Promise<ConfigKeyMeta[]> {
  const res = await hostFetch(configPath(configId, "/secrets"));
  const body = await parseJsonResponse(res, "List config keys failed");
  const keys = (Array.isArray(body.keys) ? body.keys : [])
    .filter((row): row is JsonObject => isJsonObject(row))
    .map(normalizeKeyMeta);
  assertNoSecretLeak(keys);
  return keys;
}

async function deleteConfigSecretDefault(
  configId: string,
  keyName: string,
): Promise<void> {
  const res = await hostFetch(
    configPath(configId, `/secrets/${encodeURIComponent(keyName)}`),
    { method: "DELETE" },
  );
  if (!res.ok && res.status !== 204) {
    throw new Error(`Delete config secret failed (${res.status}).`);
  }
}

async function listConfigSecretVersionsDefault(
  configId: string,
  keyName: string,
): Promise<ConfigSecretVersion[]> {
  const res = await hostFetch(
    configPath(configId, `/secrets/${encodeURIComponent(keyName)}/versions`),
  );
  const body = await parseJsonResponse(res, "List secret versions failed");
  const versions = (Array.isArray(body.versions) ? body.versions : [])
    .filter((row): row is JsonObject => isJsonObject(row))
    .map(normalizeVersion);
  assertNoSecretLeak(versions);
  return versions;
}

async function rollbackConfigSecretDefault(
  configId: string,
  keyName: string,
  toVersion: number,
) {
  const res = await hostFetch(
    configPath(configId, `/secrets/${encodeURIComponent(keyName)}/rollback`),
    {
      method: "POST",
      body: JSON.stringify({ to_version: toVersion }),
    },
  );
  const body = await parseJsonResponse(res, "Rollback failed");
  return {
    keyName: pickString(body, "key_name", "keyName") || keyName,
    version: isNumber(body.version) ? body.version : 0,
  };
}

async function compareConfigsDefault(
  a: string,
  b: string,
): Promise<ConfigCompare> {
  const res = await hostFetch(
    configPath(a, `/compare/${encodeURIComponent(b)}`),
  );
  const body = await parseJsonResponse(res, "Compare configs failed");
  const inBoth = (Array.isArray(body.in_both) ? body.in_both : [])
    .filter((row): row is JsonObject => isJsonObject(row))
    .map((row) => ({
      keyName: pickString(row, "key_name", "keyName"),
      aVersion: isNumber(row.a_version) ? row.a_version : 0,
      bVersion: isNumber(row.b_version) ? row.b_version : 0,
    }));
  const names = (rows: BoundaryValue): string[] => {
    if (!Array.isArray(rows)) return [];
    const out: string[] = [];
    for (const row of rows) if (isString(row)) out.push(row);
    return out;
  };
  const compare = {
    onlyInA: names(body.only_in_a),
    onlyInB: names(body.only_in_b),
    inBoth,
  };
  assertNoSecretLeak(compare);
  return compare;
}

async function branchConfigDefault(
  configId: string,
  input: { slug: string; displayName?: string },
): Promise<SecretConfig> {
  const res = await hostFetch(configPath(configId, "/branch"), {
    method: "POST",
    body: JSON.stringify({
      slug: input.slug,
      ...(input.displayName ? { display_name: input.displayName } : undefined),
    }),
  });
  const body = await parseJsonResponse(res, "Branch config failed");
  return normalizeConfig(body);
}

function formatConfigSummaryDefault(config: SecretConfig): string {
  const parts = [config.slug, config.environment];
  if (config.displayName && config.displayName !== config.slug) {
    parts.push(config.displayName);
  }
  if (config.parentConfigId) parts.push("branch");
  return parts.join(" · ");
}

export const secretConfigSeams = {
  listSecretConfigs: listSecretConfigsDefault,
  createSecretConfig: createSecretConfigDefault,
  deleteSecretConfig: deleteSecretConfigDefault,
  putConfigSecrets: putConfigSecretsDefault,
  listConfigKeys: listConfigKeysDefault,
  deleteConfigSecret: deleteConfigSecretDefault,
  listConfigSecretVersions: listConfigSecretVersionsDefault,
  rollbackConfigSecret: rollbackConfigSecretDefault,
  compareConfigs: compareConfigsDefault,
  branchConfig: branchConfigDefault,
  formatConfigSummary: formatConfigSummaryDefault,
};

export async function listSecretConfigs(
  projectId: string,
): Promise<SecretConfig[]> {
  return secretConfigSeams.listSecretConfigs(projectId);
}

export async function createSecretConfig(
  projectId: string,
  input: {
    slug: string;
    environment: SecretConfigEnvironment;
    displayName?: string;
    parentConfigId?: string;
  },
): Promise<SecretConfig> {
  return secretConfigSeams.createSecretConfig(projectId, input);
}

export async function deleteSecretConfig(id: string): Promise<void> {
  return secretConfigSeams.deleteSecretConfig(id);
}

export async function putConfigSecrets(
  configId: string,
  secrets: Record<string, string>,
): Promise<ConfigKeyMeta[]> {
  return secretConfigSeams.putConfigSecrets(configId, secrets);
}

export async function listConfigKeys(
  configId: string,
): Promise<ConfigKeyMeta[]> {
  return secretConfigSeams.listConfigKeys(configId);
}

export async function deleteConfigSecret(
  configId: string,
  keyName: string,
): Promise<void> {
  return secretConfigSeams.deleteConfigSecret(configId, keyName);
}

export async function listConfigSecretVersions(
  configId: string,
  keyName: string,
): Promise<ConfigSecretVersion[]> {
  return secretConfigSeams.listConfigSecretVersions(configId, keyName);
}

export async function rollbackConfigSecret(
  configId: string,
  keyName: string,
  toVersion: number,
): Promise<{ keyName: string; version: number }> {
  return secretConfigSeams.rollbackConfigSecret(configId, keyName, toVersion);
}

export async function compareConfigs(
  a: string,
  b: string,
): Promise<ConfigCompare> {
  return secretConfigSeams.compareConfigs(a, b);
}

export async function branchConfig(
  configId: string,
  input: { slug: string; displayName?: string },
): Promise<SecretConfig> {
  return secretConfigSeams.branchConfig(configId, input);
}

export function formatConfigSummary(config: SecretConfig): string {
  return secretConfigSeams.formatConfigSummary(config);
}
