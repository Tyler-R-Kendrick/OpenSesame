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
export const CATEGORY = new Map<ProviderCategory, readonly string[]>([
  ["identity", ["better-auth", "workos", "auth0"]],
  [
    "backup_recovery",
    ["github", "gitlab", "bitbucket", "codeberg", "origin", "git"],
  ],
  [
    "encryption",
    [
      "webcrypto",
      "age",
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

export const NAMES = new Map(
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
    bitbucket: "Bitbucket",
    codeberg: "Codeberg",
    origin: "Cursor Origin",
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

export const LLM = [
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

export const HOST = [
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
    id: "bitbucket",
    docs: "https://support.atlassian.com/bitbucket-cloud/docs/use-oauth-on-bitbucket-cloud/",
    auth: "oauth2_authorization_code",
    refresh: true,
    authorities: ["api.bitbucket.org", "bitbucket.org"],
    operations: ["repository.read", "repository.write", "pullrequest.create"],
  },
  {
    id: "codeberg",
    docs: "https://docs.codeberg.org/advanced/access-token/",
    auth: "oauth2_authorization_code",
    refresh: true,
    authorities: ["codeberg.org"],
    operations: ["repository.read", "repository.write", "pullrequest.create"],
  },
  {
    id: "origin",
    docs: "https://cursor.com/docs/api/origin",
    auth: "oauth2_authorization_code",
    refresh: false,
    authorities: ["api.cursor.com", "origin.cursor.com", "cursor.com"],
    operations: ["repository.read", "repository.write", "pullrequest.create"],
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

export const IDENTITY = [
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

export const NETWORKING = [
  ["tailscale", "https://tailscale.com/kb/1085/auth-keys", "configuration"],
] as const;
export const WALLET = [
  ["cloudflare-wallet", "https://developers.cloudflare.com/", "configuration"],
  ["google-wallet", "https://developers.google.com/wallet", "configuration"],
  ["apple-wallet", "https://developer.apple.com/wallet/", "configuration"],
  ["samsung-wallet", "https://developer.samsung.com/wallet", "configuration"],
] as const;
export const BUNDLED_REVISION = "2026-09-21.3";
