import {
  type BoundaryValue,
  type JsonObject,
  isBoolean,
  isJsonObject,
  isString,
  overlapCast,
} from "@opensesame/os-domain";
import parity from "../../../../connectors/fnox-parity.json";
import type {
  ConfigurationField,
  Provider,
  ProviderCategory,
} from "./connections.js";
import { loadSettings } from "./settings.js";

const CATEGORY = new Map<ProviderCategory, readonly string[]>([
  [
    "encryption",
    [
      "webcrypto",
      "age",
      "fido2",
      "yubikey",
      "aws-kms",
      "azure-key-vault-keys",
      "gcp-kms",
      "sealed-local",
    ],
  ],
  [
    "cloud_secret_storage",
    [
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
  ],
  [
    "password_managers",
    [
      "1password",
      "bitwarden",
      "vaultwarden",
      "infisical",
      "proton-pass",
      "passwordstate",
    ],
  ],
  ["local_storage", ["keychain", "keepass", "password-store", "plain"]],
  ["certificates", ["letsencrypt", "zerossl", "cloudflare-origin-ca"]],
  ["developer", ["github", "gitlab", "vercel"]],
  ["productivity", ["linear"]],
  ["communication", []],
  ["storage", []],
  ["crm", []],
  ["payments", ["stripe"]],
  ["identity", []],
  ["testing", []],
]);

const PROVIDER_CATEGORIES = new Set<string>(CATEGORY.keys());

const NAMES = new Map(
  Object.entries({
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
    github: "GitHub",
    gitlab: "GitLab",
    linear: "Linear",
    stripe: "Stripe",
    vercel: "Vercel",
    foks: "FOKS",
    "gcp-kms": "Google Cloud KMS",
    "gcp-secret-manager": "Google Cloud Secret Manager",
    huggingface: "Hugging Face",
    keepass: "KeePass",
    letsencrypt: "Let's Encrypt",
    zerossl: "ZeroSSL",
    "cloudflare-origin-ca": "Cloudflare Origin CA",
    "password-store": "password-store",
    "proton-pass": "Proton Pass",
    "sealed-local": "Sealed local",
    webcrypto: "WebCrypto",
    "encrypted-remote": "Encrypted remote",
    vault: "HashiCorp Vault",
    workos: "WorkOS",
    yubikey: "YubiKey",
  }),
);

const FIELDS = new Map<string, ConfigurationField[]>(
  Object.entries({
    age: [
      {
        name: "recipients",
        label: "Recipients",
        secret: false,
        required: true,
      },
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
      {
        name: "server_url",
        label: "Server URL",
        secret: false,
        required: false,
      },
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
      {
        name: "project_id",
        label: "Project ID",
        secret: false,
        required: false,
      },
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
  }),
);

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

const HOST = [
  {
    id: "github",
    docs: "https://docs.github.com/apps/oauth-apps",
    auth: "oauth2_authorization_code",
    refresh: false,
    authorities: ["api.github.com", "github.com"],
    operations: [
      "repository.read",
      "contents.write",
      "git.push",
      "pull_request.create",
      "issue.create",
    ],
  },
  {
    id: "gitlab",
    docs: "https://docs.gitlab.com/ee/api/oauth2.html",
    auth: "oauth2_authorization_code",
    refresh: true,
    authorities: ["gitlab.com"],
    operations: ["project.read", "repository.write", "merge_request.create"],
  },
  {
    id: "vercel",
    docs: "https://vercel.com/docs/rest-api",
    auth: "api_key",
    refresh: false,
    authorities: ["api.vercel.com", "vercel.com"],
    operations: ["deployment.read", "project.write", "domain.read"],
  },
  {
    id: "linear",
    docs: "https://linear.app/developers/oauth-2-0-authentication",
    auth: "oauth2_authorization_code",
    refresh: true,
    authorities: ["api.linear.app", "linear.app"],
    operations: ["issue.read", "issue.create", "project.read"],
  },
  {
    id: "stripe",
    docs: "https://docs.stripe.com/keys",
    auth: "api_key",
    refresh: false,
    authorities: ["api.stripe.com", "stripe.com"],
    operations: ["customer.read", "charge.read", "invoice.read"],
  },
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

const BUNDLED_REVISION = "2026-08-13.1";

function title(id: string): string {
  return (
    NAMES.get(id) ??
    id.replace(
      /(^|-)([a-z])/g,
      (_, separator: string, letter: string) =>
        `${separator ? " " : ""}${letter.toUpperCase()}`,
    )
  );
}

function categoryOf(id: string): ProviderCategory {
  for (const [category, providerIds] of CATEGORY) {
    if (providerIds.includes(id)) {
      return category;
    }
  }
  return "developer";
}

function isProviderCategory(value: string): value is ProviderCategory {
  return PROVIDER_CATEGORIES.has(value);
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
    autoConfigurable:
      id === "plain" || id === "sealed-local" || id === "webcrypto",
    missingConfig: [],
    callbackUrl: null,
    scopes: [],
    egress: { scheme: "none", authorities: [], pathPrefixes: [] },
    operations: [
      authKind === "configuration" ? "secret.configure" : "model.invoke",
    ],
    configurationFields: FIELDS.get(id) ?? [],
  };
}

export const bundledProviders: Provider[] = [
  (() => {
    const provider = preview(
      "webcrypto",
      "https://developer.mozilla.org/docs/Web/API/Web_Crypto_API",
      "configuration",
      "encryption",
    );
    provider.displayName = "WebCrypto (this device)";
    provider.autoConfigurable = true;
    provider.configured = true;
    provider.operations = ["key.wrap", "key.unwrap", "aead.seal"];
    return provider;
  })(),
  ...parity.providers.map((id) =>
    preview(id, `https://fnox.jdx.dev/providers/${id}.html`, "configuration"),
  ),
  ...HOST.map((entry) => {
    const provider = preview(entry.id, entry.docs, entry.auth);
    provider.supportsRefresh = entry.refresh;
    provider.operations = [...entry.operations];
    provider.egress = {
      scheme: "https",
      authorities: [...entry.authorities],
      pathPrefixes: [],
    };
    return provider;
  }),
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
    get(...values: string[]): Promise<JsonObject | undefined>;
    run(...values: string[]): Promise<BoundaryValue>;
  }>;
  pull(): Promise<boolean>;
  push(): Promise<void>;
  close(): Promise<void>;
};

let database: Promise<TursoDb> | null = null;
let sessionToken = import.meta.env.VITE_TURSO_AUTH_TOKEN?.trim() ?? "";
let lastMode: "embedded" | "remote" | "memory" = "memory";

/** Turso WASM + OPFS can hang on some static hosts; never block the gallery on it. */
const TURSO_OPEN_MS = 2500;

export function tursoMode(): typeof lastMode {
  return lastMode;
}

function setTursoSessionTokenDefault(token: string): void {
  sessionToken = token.trim();
  const current = database;
  database = null;
  if (current) void current.then((db) => db.close()).catch(() => undefined);
}

async function checkTursoDefault(): Promise<typeof lastMode> {
  try {
    await db();
  } catch {
    lastMode = "memory";
  }
  return lastMode;
}

function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label}_timeout`));
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function open(): Promise<TursoDb> {
  const settings = loadSettings();
  const remote = settings.tursoUrl.trim();
  const { connectTurso } = await import("./turso-connect.js");
  const database: TursoDb = overlapCast(
    await connectTurso({
      path: "opensesame-connectors.db",
      ...(remote && sessionToken
        ? { url: remote, authToken: () => Promise.resolve(sessionToken) }
        : undefined),
      clientName: "opensesame-pages",
    }),
  );
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
  if (!database) {
    database = withTimeout(open(), TURSO_OPEN_MS, "turso_open").catch(
      (error) => {
        database = null;
        lastMode = "memory";
        throw error;
      },
    );
  }
  return database;
}

function validProvider(value: BoundaryValue): value is Provider {
  if (!isJsonObject(value)) return false;
  const item = value;
  return (
    isString(item.id) &&
    isString(item.displayName) &&
    isString(item.category) &&
    isString(item.docsUrl) &&
    isString(item.authKind) &&
    isBoolean(item.configured) &&
    isBoolean(item.autoConfigurable) &&
    Array.isArray(item.missingConfig) &&
    Array.isArray(item.scopes) &&
    Array.isArray(item.operations)
  );
}

export function decodeEmbeddedProviders(value: string): Provider[] | null {
  let parsed: BoundaryValue;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  if (
    !isJsonObject(parsed) ||
    parsed.revision !== BUNDLED_REVISION ||
    !Array.isArray(parsed.providers)
  ) {
    return null;
  }
  const providers = parsed.providers;
  return providers.length > 0 && providers.every(validProvider)
    ? providers
    : null;
}

async function readEmbeddedProvidersDefault(): Promise<Provider[]> {
  try {
    const connection = await db();
    const row = await withTimeout(
      (
        await connection.prepare("SELECT value FROM pwa_cache WHERE key = ?")
      ).get("providers"),
      TURSO_OPEN_MS,
      "turso_read",
    );
    if (isString(row?.value)) {
      const providers = decodeEmbeddedProviders(row.value);
      if (providers) return providers;
    }
    await writeEmbeddedProviders(getBundledProviders());
  } catch {
    lastMode = "memory";
    database = null;
  }
  return getBundledProviders();
}

async function writeEmbeddedProvidersDefault(
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

export const embeddedCatalogSeams = {
  setTursoSessionToken: setTursoSessionTokenDefault,
  checkTurso: checkTursoDefault,
  bundledProviders,
  readEmbeddedProviders: readEmbeddedProvidersDefault,
  writeEmbeddedProviders: writeEmbeddedProvidersDefault,
};

export function getBundledProviders(): Provider[] {
  return embeddedCatalogSeams.bundledProviders;
}

export function setTursoSessionToken(token: string): void {
  embeddedCatalogSeams.setTursoSessionToken(token);
}

export async function checkTurso(): Promise<typeof lastMode> {
  return embeddedCatalogSeams.checkTurso();
}

export async function readEmbeddedProviders(): Promise<Provider[]> {
  return embeddedCatalogSeams.readEmbeddedProviders();
}

export async function writeEmbeddedProviders(
  providers: Provider[],
): Promise<void> {
  return embeddedCatalogSeams.writeEmbeddedProviders(providers);
}
