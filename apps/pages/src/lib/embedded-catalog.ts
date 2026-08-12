import parity from "../../../../fnox/connectors/fnox-parity.json";
import type { Provider, ProviderCategory } from "./connections.js";
import { loadSettings } from "./settings.js";

const CATEGORY: Record<ProviderCategory, readonly string[]> = {
  encryption: [
    "age",
    "fido2",
    "yubikey",
    "aws-kms",
    "azure-key-vault-keys",
    "gcp-kms",
    "sealed-local",
  ],
  cloud_secret_storage: [
    "aws-parameter-store",
    "aws-secrets-manager",
    "azure-app-configuration",
    "azure-key-vault-secrets",
    "gcp-secret-manager",
    "doppler",
    "foks",
    "bitwarden-secrets-manager",
    "vault",
    "openbao",
    "encrypted-remote",
  ],
  password_managers: [
    "1password",
    "bitwarden",
    "vaultwarden",
    "infisical",
    "proton-pass",
    "passwordstate",
  ],
  local_storage: ["keychain", "keepass", "password-store", "plain"],
  developer: [],
  productivity: [],
  communication: [],
  storage: [],
  crm: [],
  payments: [],
  identity: [],
  testing: [],
};

const NAMES: Record<string, string> = {
  "1password": "1Password",
  "aws-bedrock": "AWS Bedrock",
  "aws-kms": "AWS KMS",
  "aws-parameter-store": "AWS Parameter Store",
  "aws-secrets-manager": "AWS Secrets Manager",
  "azure-app-configuration": "Azure App Configuration",
  "azure-key-vault-keys": "Azure Key Vault Keys",
  "azure-key-vault-secrets": "Azure Key Vault Secrets",
  "azure-openai": "Azure OpenAI",
  "bitwarden-secrets-manager": "Bitwarden Secrets Manager",
  "better-auth": "Better Auth",
  fido2: "FIDO2",
  foks: "FOKS",
  "gcp-kms": "Google Cloud KMS",
  "gcp-secret-manager": "Google Cloud Secret Manager",
  huggingface: "Hugging Face",
  keepass: "KeePass",
  "password-store": "password-store",
  "proton-pass": "Proton Pass",
  "sealed-local": "Sealed local",
  "encrypted-remote": "Encrypted remote",
  vault: "HashiCorp Vault",
  workos: "WorkOS",
  yubikey: "YubiKey",
};

const FIELDS: Record<string, Provider["configurationFields"]> = {
  age: [
    { name: "recipients", label: "Recipients", secret: false, required: true },
    { name: "identity", label: "Identity", secret: true, required: true },
  ],
  "better-auth": [
    { name: "base_url", label: "Base URL", secret: false, required: true },
    { name: "api_key", label: "API key", secret: true, required: true },
    {
      name: "api_key_header",
      label: "API key header",
      secret: false,
      required: true,
    },
    { name: "config_id", label: "Config ID", secret: false, required: false },
  ],
  auth0: [
    { name: "domain", label: "Tenant domain", secret: false, required: true },
    { name: "client_id", label: "Client ID", secret: false, required: true },
    {
      name: "client_secret",
      label: "Client secret",
      secret: true,
      required: true,
    },
    { name: "audience", label: "Audience", secret: false, required: false },
  ],
  bitwarden: [
    {
      name: "session_token",
      label: "Session token",
      secret: true,
      required: false,
    },
    { name: "server_url", label: "Server URL", secret: false, required: false },
  ],
  "bitwarden-secrets-manager": [
    {
      name: "access_token",
      label: "Access token",
      secret: true,
      required: true,
    },
    {
      name: "organization_id",
      label: "Organization ID",
      secret: false,
      required: false,
    },
    { name: "project_id", label: "Project ID", secret: false, required: false },
  ],
  keychain: [
    { name: "service", label: "Service", secret: false, required: true },
  ],
  keepass: [
    {
      name: "database_path",
      label: "Database path",
      secret: false,
      required: true,
    },
    { name: "password", label: "Password", secret: true, required: true },
  ],
  "password-store": [
    {
      name: "store_dir",
      label: "Store directory",
      secret: false,
      required: true,
    },
  ],
  plain: [
    { name: "namespace", label: "Namespace", secret: false, required: true },
  ],
};

const LLM = [
  ["anthropic", "https://docs.anthropic.com/en/api/getting-started", "api_key"],
  [
    "openai",
    "https://platform.openai.com/docs/api-reference/authentication",
    "api_key",
  ],
  [
    "azure-openai",
    "https://learn.microsoft.com/azure/ai-services/openai/reference",
    "configuration",
  ],
  [
    "aws-bedrock",
    "https://docs.aws.amazon.com/bedrock/latest/userguide/api-setup.html",
    "configuration",
  ],
  [
    "openrouter",
    "https://openrouter.ai/docs/guides/overview/auth/oauth",
    "oauth2_authorization_code",
  ],
  ["huggingface", "https://huggingface.co/docs/inference-providers", "api_key"],
] as const;

const IDENTITY = [
  [
    "better-auth",
    "https://better-auth.com/docs/plugins/api-key",
    "configuration",
  ],
  ["workos", "https://workos.com/docs/reference/api-authentication", "api_key"],
  [
    "auth0",
    "https://auth0.com/docs/secure/tokens/access-tokens/get-access-tokens",
    "configuration",
  ],
] as const;

const BUNDLED_REVISION = "2026-08-12.2";

function title(id: string): string {
  return (
    NAMES[id] ??
    id.replace(
      /(^|-)([a-z])/g,
      (_, separator: string, letter: string) =>
        `${separator ? " " : ""}${letter.toUpperCase()}`,
    )
  );
}

function categoryOf(id: string): ProviderCategory {
  for (const [category, ids] of Object.entries(CATEGORY)) {
    if (ids.includes(id)) return category as ProviderCategory;
  }
  return "developer";
}

function preview(
  id: string,
  docsUrl: string,
  authKind: Provider["authKind"],
  category = categoryOf(id),
): Provider {
  return {
    id,
    displayName: title(id),
    category,
    docsUrl,
    authKind,
    supportsRefresh: false,
    configured: false,
    missingConfig: [],
    scopes: [],
    egress: { scheme: "none", authorities: [], pathPrefixes: [] },
    operations: [
      authKind === "configuration" ? "secret.configure" : "model.invoke",
    ],
    configurationFields: FIELDS[id] ?? [],
  };
}

export const bundledProviders: Provider[] = [
  ...parity.providers.map((id) =>
    preview(id, `https://fnox.jdx.dev/providers/${id}.html`, "configuration"),
  ),
  ...LLM.map(([id, docs, auth]) => preview(id, docs, auth, "developer")),
  ...IDENTITY.map(([id, docs, auth]) => {
    const provider = preview(id, docs, auth, "identity");
    provider.operations =
      id === "workos"
        ? ["user.read", "organization.read", "directory.read"]
        : ["identity.configure"];
    if (id === "workos") {
      provider.egress = {
        scheme: "https",
        authorities: ["api.workos.com"],
        pathPrefixes: [],
      };
    }
    return provider;
  }),
];

type TursoDb = {
  exec(sql: string): Promise<void>;
  prepare(sql: string): Promise<{
    get(...values: unknown[]): Promise<Record<string, unknown> | undefined>;
    run(...values: unknown[]): Promise<unknown>;
  }>;
  pull(): Promise<boolean>;
  push(): Promise<void>;
  close(): Promise<void>;
};

let database: Promise<TursoDb> | null = null;
let sessionToken = import.meta.env.VITE_TURSO_AUTH_TOKEN?.trim() ?? "";
let lastMode: "embedded" | "remote" | "memory" = "memory";

export function tursoMode(): typeof lastMode {
  return lastMode;
}

export function setTursoSessionToken(token: string): void {
  sessionToken = token.trim();
  const current = database;
  database = null;
  if (current) void current.then((db) => db.close()).catch(() => undefined);
}

export async function checkTurso(): Promise<typeof lastMode> {
  try {
    await db();
  } catch {
    lastMode = "memory";
  }
  return lastMode;
}

async function open(): Promise<TursoDb> {
  const settings = loadSettings();
  const remote = settings.tursoUrl.trim();
  const module = await import("@tursodatabase/sync-wasm/vite");
  const database = (await module.connect({
    path: "opensesame-connectors.db",
    ...(remote && sessionToken
      ? { url: remote, authToken: () => Promise.resolve(sessionToken) }
      : {}),
    clientName: "opensesame-pages",
  })) as TursoDb;
  if (remote && sessionToken) {
    try {
      await database.pull();
      lastMode = "remote";
    } catch {
      lastMode = "embedded";
    }
  } else {
    lastMode = "embedded";
  }
  await database.exec(
    "CREATE TABLE IF NOT EXISTS pwa_cache (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL)",
  );
  return database;
}

async function db(): Promise<TursoDb> {
  database ??= open();
  return database;
}

function validProvider(value: unknown): value is Provider {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<Provider>;
  return (
    typeof item.id === "string" &&
    typeof item.displayName === "string" &&
    typeof item.category === "string" &&
    typeof item.docsUrl === "string" &&
    typeof item.authKind === "string" &&
    typeof item.configured === "boolean" &&
    Array.isArray(item.missingConfig) &&
    Array.isArray(item.scopes) &&
    Array.isArray(item.operations)
  );
}

export function decodeEmbeddedProviders(value: string): Provider[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    (parsed as { revision?: unknown }).revision !== BUNDLED_REVISION ||
    !Array.isArray((parsed as { providers?: unknown }).providers)
  ) {
    return null;
  }
  const providers = (parsed as { providers: unknown[] }).providers;
  return providers.length > 0 && providers.every(validProvider)
    ? providers
    : null;
}

export async function readEmbeddedProviders(): Promise<Provider[]> {
  try {
    const connection = await db();
    const row = await (
      await connection.prepare("SELECT value FROM pwa_cache WHERE key = ?")
    ).get("providers");
    if (typeof row?.value === "string") {
      const providers = decodeEmbeddedProviders(row.value);
      if (providers) return providers;
    }
    await writeEmbeddedProviders(bundledProviders);
  } catch {
    lastMode = "memory";
  }
  return bundledProviders;
}

export async function writeEmbeddedProviders(
  providers: Provider[],
): Promise<void> {
  try {
    const connection = await db();
    await (
      await connection.prepare(
        "INSERT INTO pwa_cache (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
      )
    ).run(
      "providers",
      JSON.stringify({ revision: BUNDLED_REVISION, providers }),
      new Date().toISOString(),
    );
    if (lastMode === "remote") await connection.push();
  } catch {
    lastMode = "memory";
  }
}
