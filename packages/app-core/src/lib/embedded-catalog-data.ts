import type { ConfigurationField } from "./connections.js";

/**
 * The catalog rows this app shows without a Host, in display order. Each is
 * a row of `spec/connectors/catalog.json` (by id or alias) and takes its data
 * from there; this list only chooses and orders. `connector-catalog.test.ts`
 * fails on an id the catalog does not have.
 */
export const DEVICE_KEY_PROTECTORS = [
  "webcrypto",
  "aws-kms",
  "gcp-kms",
] as const;

/**
 * Catalog rows Pages does not draw because a browser cannot enroll them as a
 * vault key protector (docs/adr/0152). The Host and the native client keep
 * them; this is only what this target shows.
 */
export const BROWSER_UNENROLLABLE_PROTECTORS = [
  "yubikey",
  "azure-key-vault-keys",
] as const;

export const HOST_PROVIDER_IDS = [
  "github",
  "gitlab",
  "bitbucket",
  "codeberg",
  "origin",
  "vercel",
  "linear",
] as const;

export const LLM_PROVIDER_IDS = [
  "anthropic",
  "openai",
  "azure-openai",
  "aws-bedrock",
  "openrouter",
  "huggingface",
] as const;

export const IDENTITY_PROVIDER_IDS = [
  "better-auth",
  "workos",
  "auth0",
] as const;

export const NETWORKING_PROVIDER_IDS = ["tailscale"] as const;

export const WALLET_PROVIDER_IDS = [
  "cloudflare-wallet",
  "google-wallet",
  "apple-wallet",
  "samsung-wallet",
] as const;

/**
 * Card issuers (catalog category `wallet`). Their rows are bundled on every
 * installation; the spending flow that uses them (`wallet-issuers.ts`) is
 * `wallet.spending`'s, so the list lives here where the catalog reads it.
 */
export const WALLET_ISSUER_PROVIDER_IDS = [
  "privacy",
  "lithic",
  "marqeta",
  "stripe-issuing",
] as const;

/**
 * Object stores the vault can live in (catalog category `local_storage`).
 * The bucket is saved on this device like any configuration connector;
 * `secret-fs/bucket-boot.ts` reads it at boot (ADR 0182).
 */
export const STORAGE_PROVIDER_IDS = ["s3"] as const;

/**
 * Field sets this app collects that differ from the catalog row's. Each is a
 * known divergence from the one definition: `connector-catalog.test.ts` pins
 * the ids, so the list can shrink but never grow.
 */
export function field(
  name: string,
  label: string,
  secret = false,
  required = true,
): ConfigurationField {
  return { name, label, secret, required };
}

export const FIELDS = new Map<string, ConfigurationField[]>(
  Object.entries({
    age: [
      field("recipients", "Recipients"),
      field("identity", "Identity", true),
    ],
    "aws-kms": [
      field("key_arn", "Key ARN"),
      field("region", "Region"),
      field("access_key_id", "Access key ID"),
      field("secret_access_key", "Secret access key", true),
      field("session_token", "Session token", true, false),
    ],
    "gcp-kms": [
      field("crypto_key_name", "Crypto key"),
      field("project_id", "Project ID"),
      field("service_account_json", "Service account JSON", true),
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
