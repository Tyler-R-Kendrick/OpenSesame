import {
  type BoundaryValue,
  isBoolean,
  isJsonObject,
  isString,
} from "@opensesame/os-domain";
import parity from "../../../../connectors/fnox-parity.json";
import type {
  ConfigurationField,
  Provider,
  ProviderCategory,
} from "./connections.js";
import { bundledGitProvider } from "./embedded-git.js";
import { walletHostProviders } from "./wallet-issuers.js";
const CATEGORY = new Map<ProviderCategory, readonly string[]>([
  ["identity", ["better-auth", "workos", "auth0"]],
  ["backup_recovery", ["github", "gitlab", "git"]],
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
  [
    "agent_harnesses",
    [
      "anthropic",
      "openai",
      "azure-openai",
      "aws-bedrock",
      "openrouter",
      "huggingface",
    ],
  ],
  ["networking", ["tailscale"]],
  [
    "wallet",
    ["cloudflare-wallet", "google-wallet", "apple-wallet", "samsung-wallet"],
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
  ["local_storage", ["keychain", "keepass", "password-store", "plain"]],
  ["certificates", ["letsencrypt", "zerossl", "cloudflare-origin-ca"]],
  ["developer", ["vercel"]],
  ["productivity", ["linear"]],
]);

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

function field(
  name: string,
  label: string,
  secret = false,
  required = true,
): ConfigurationField {
  return { name, label, secret, required };
}

const FIELDS = new Map<string, ConfigurationField[]>(
  Object.entries({
    age: [
      field("recipients", "Recipients"),
      field("identity", "Identity", true),
    ],
    "better-auth": [
      field("base_url", "Base URL"),
      field("api_key", "API key", true),
      field("api_key_header", "API key header"),
      field("config_id", "Config ID", false, false),
    ],
    tailscale: [
      field("tailnet", "Tailnet"),
      field("hostname", "Hostname", false, false),
      field("auth_key", "Auth key", true),
      field("socket", "Socket", false, false),
    ],
    "cloudflare-wallet": [
      field("account_id", "Account ID"),
      field("wallet_id", "Wallet ID"),
      field("api_token", "API token", true),
    ],
    "google-wallet": [
      field("issuer_id", "Issuer ID"),
      field("class_id", "Class ID"),
      field("service_account_email", "Service account email"),
      field("service_account_key", "Service account key", true),
    ],
    "apple-wallet": [
      field("pass_type_id", "Pass type ID"),
      field("team_id", "Team ID"),
      field("certificate", "Pass certificate", true),
    ],
    "samsung-wallet": [
      field("service_id", "Service ID"),
      field("api_key", "API key", true),
    ],
    auth0: [
      field("domain", "Tenant domain"),
      field("client_id", "Client ID"),
      field("client_secret", "Client secret", true),
      field("audience", "Audience", false, false),
    ],
    bitwarden: [
      field("session_token", "Session token", true, false),
      field("server_url", "Server URL", false, false),
    ],
    "bitwarden-secrets-manager": [
      field("access_token", "Access token", true),
      field("organization_id", "Organization ID", false, false),
      field("project_id", "Project ID", false, false),
    ],
    keychain: [field("service", "Service")],
    keepass: [
      field("database_path", "Database path"),
      field("password", "Password", true),
    ],
    "password-store": [field("store_dir", "Store directory")],
    plain: [field("namespace", "Namespace")],
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
    docs: "https://vercel.com/docs/rest-api/reference/sdk",
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

const NETWORKING = [
  ["tailscale", "https://tailscale.com/kb/1085/auth-keys", "configuration"],
] as const;
const WALLET = [
  ["cloudflare-wallet", "https://developers.cloudflare.com/", "configuration"],
  ["google-wallet", "https://developers.google.com/wallet", "configuration"],
  ["apple-wallet", "https://developer.apple.com/wallet/", "configuration"],
  ["samsung-wallet", "https://developer.samsung.com/wallet", "configuration"],
] as const;
const BUNDLED_REVISION = "2026-09-17.3";

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
    if (providerIds.includes(id)) return category;
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
  ...LLM.map(([id, docs, auth]) => preview(id, docs, auth, "agent_harnesses")),
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
  ...NETWORKING.map(([id, docs, auth]) =>
    Object.assign(preview(id, docs, auth, "networking"), {
      operations: ["network.configure"],
    }),
  ),
  ...WALLET.map(([id, docs, auth]) =>
    Object.assign(preview(id, docs, auth, "wallet"), {
      operations: ["wallet.configure"],
    }),
  ),
  ...walletHostProviders((id, docs, auth) => preview(id, docs, auth, "wallet")),
];

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
  return getBundledProviders();
}

async function writeEmbeddedProvidersDefault(
  _providers: Provider[],
): Promise<void> {}

export const embeddedCatalogSeams = {
  bundledProviders,
  readEmbeddedProviders: readEmbeddedProvidersDefault,
  writeEmbeddedProviders: writeEmbeddedProvidersDefault,
};

export function getBundledProviders(): Provider[] {
  return [bundledGitProvider(), ...embeddedCatalogSeams.bundledProviders];
}

export async function readEmbeddedProviders(): Promise<Provider[]> {
  return embeddedCatalogSeams.readEmbeddedProviders();
}

export async function writeEmbeddedProviders(
  providers: Provider[],
): Promise<void> {
  return embeddedCatalogSeams.writeEmbeddedProviders(providers);
}
