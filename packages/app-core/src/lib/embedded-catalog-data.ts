import { AI_MODEL_PROVIDER_IDS } from "./ai-model-provider-ids.generated.js";
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

/**
 * Every hosted model provider the catalog lists (ADR 0192), generated from
 * the catalog's `ai_model_provider` rows so a new row is drawn without a
 * second list to keep in step.
 */
export const LLM_PROVIDER_IDS = AI_MODEL_PROVIDER_IDS;

export const IDENTITY_PROVIDER_IDS = [
  "byo-identity",
  "better-auth",
  "supabase",
  "neon-auth",
  "clerk",
  "workos",
  "auth0",
  "okta",
] as const;

/** Browser secret stores share the configured partner protocols and local ports. */
export const SECRET_BACKEND_PROVIDER_IDS = [
  "byo-secret-backend",
  "local-vault",
  "browser-credentials",
] as const;

export const NETWORKING_PROVIDER_IDS = ["tailscale"] as const;

export const WALLET_PROVIDER_IDS = [
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
 * Certificate authorities a browser can be an ACME client of (catalog category
 * `certificates`, ADR 0198): the account key is made here and the order is
 * opened and finished from the connection's page.
 */
export const CERTIFICATE_PROVIDER_IDS = ["letsencrypt"] as const;

/**
 * Cloud credential services a browser reaches with the person's own key (catalog
 * category `cloud_secret_storage`, ADR 0198): what a key is, and what it may
 * assume, rather than a store of secrets.
 */
export const CLOUD_CREDENTIAL_PROVIDER_IDS = [
  "aws-sts",
  "gcp-iam",
  "azure-access-token",
  "azure-kms",
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
    tailscale: [
      field("tailnet", "Tailnet"),
      field("hostname", "Hostname", false, false),
      field("auth_key", "Auth key", true),
      field("socket", "Socket", false, false),
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
