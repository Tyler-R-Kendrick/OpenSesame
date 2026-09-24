import type { ConfigurationField } from "./connections.js";

/**
 * The catalog rows this app shows without a Host, in display order. Each is
 * a row of `spec/connectors/catalog.json` (by id or alias) and takes its data
 * from there; this list only chooses and orders. `connector-catalog.test.ts`
 * fails on an id the catalog does not have.
 */
export const DEVICE_KEY_PROTECTORS = [
  "webcrypto",
  "yubikey",
  "aws-kms",
  "azure-key-vault-keys",
  "gcp-kms",
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
    yubikey: [
      field("recipient", "Recipient"),
      field("slot", "PIV slot", false, false),
      field("serial", "Serial", false, false),
    ],
    "aws-kms": [
      field("key_arn", "Key ARN"),
      field("region", "Region"),
      field("access_key_id", "Access key ID"),
      field("secret_access_key", "Secret access key", true),
      field("session_token", "Session token", true, false),
    ],
    "azure-key-vault-keys": [
      field("versioned_key_id", "Versioned key ID"),
      field("tenant_id", "Tenant ID"),
      field("client_id", "Client ID"),
      field("client_secret", "Client secret", true),
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
