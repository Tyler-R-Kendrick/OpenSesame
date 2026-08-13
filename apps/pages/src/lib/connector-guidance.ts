import type { ConfigurationField, Provider } from "./connections.js";

type FieldGuidance = { help: string; placeholder: string };

const CATEGORY_SUMMARY: Record<Provider["category"], string> = {
  encryption: "Encrypt secrets before they are stored or committed.",
  cloud_secret_storage: "Read secrets from a centralized cloud service.",
  password_managers: "Use secrets already managed by this password service.",
  local_storage: "Use credentials available on the Host machine.",
  developer:
    "Give approved projects and agents access without exposing the credential.",
  productivity: "Authorize selected actions in your workspace account.",
  communication: "Authorize selected actions in your communication account.",
  storage: "Authorize selected files and storage actions.",
  crm: "Authorize selected customer-data actions.",
  payments: "Authorize selected payment-platform actions.",
  identity: "Use this identity device or service from the Host.",
  testing: "Exercise the connection flow without a production provider.",
};

const FIELD_GUIDANCE: Record<string, FieldGuidance> = {
  recipients: {
    help: "One or more age recipients, such as age1… or an SSH public key. Secrets are encrypted so only these recipients can decrypt them.",
    placeholder: "age1… or ssh-ed25519 …",
  },
  identity: {
    help: "The private age identity that matches a recipient. Paste it once; OpenSesame seals it immediately.",
    placeholder: "AGE-SECRET-KEY-…",
  },
  credential_id: {
    help: "The credential identifier created when you registered the FIDO2 security key for this provider.",
    placeholder: "Credential ID",
  },
  recipient: {
    help: "The public recipient produced for this YubiKey. It is safe to identify the key; the private key stays on the device.",
    placeholder: "age1yubikey…",
  },
  slot: {
    help: "The YubiKey PIV slot holding the key. Leave blank to use the provider default.",
    placeholder: "9a",
  },
  pin: {
    help: "The device PIN, only when your key requires one for this operation.",
    placeholder: "Paste PIN once",
  },
  region: {
    help: "The provider region containing the resource, for example us-east-1.",
    placeholder: "us-east-1",
  },
  access_key_id: {
    help: "An access-key ID for a dedicated, least-privilege service identity.",
    placeholder: "AKIA…",
  },
  secret_access_key: {
    help: "The matching secret access key. OpenSesame seals it and never returns it to the browser.",
    placeholder: "Paste secret access key once",
  },
  session_token: {
    help: "A temporary session token when the credential was issued by STS or a password-manager login. Leave blank for long-lived credentials.",
    placeholder: "Optional temporary token",
  },
  endpoint: {
    help: "The full service or vault URL shown in the provider console.",
    placeholder: "https://example.vault.azure.net",
  },
  api_key_header: {
    help: "The request header configured by the Better Auth API Key plugin. Its default is x-api-key.",
    placeholder: "x-api-key",
  },
  config_id: {
    help: "The Better Auth API Key plugin configuration ID. Keep default unless the server defines multiple key configurations.",
    placeholder: "default",
  },
  domain: {
    help: "Your Auth0 tenant or custom domain without a path. OpenSesame derives the Management API audience from it when Audience is blank.",
    placeholder: "tenant.us.auth0.com",
  },
  audience: {
    help: "The Auth0 API identifier. Leave blank to use https://<tenant-domain>/api/v2/ for the Management API.",
    placeholder: "Derived from tenant domain",
  },
  tenant_id: {
    help: "The directory or tenant ID that owns the application registration.",
    placeholder: "00000000-0000-0000-0000-000000000000",
  },
  client_id: {
    help: "The application or client ID from the provider app registration.",
    placeholder: "Application client ID",
  },
  client_secret: {
    help: "The client secret value, not its name or secret ID. It is sealed immediately.",
    placeholder: "Paste client secret value once",
  },
  project_id: {
    help: "The cloud project that owns the secret or service account.",
    placeholder: "my-project-id",
  },
  service_account_json: {
    help: "The complete service-account JSON credential with only the permissions this connection needs.",
    placeholder: "Paste service-account JSON once",
  },
  service_account_token: {
    help: "A dedicated 1Password service-account token with access only to the vaults this connection needs.",
    placeholder: "Paste service-account token once",
  },
  access_token: {
    help: "A provider access token scoped to the organization or project this connection should use.",
    placeholder: "Paste access token once",
  },
  organization_id: {
    help: "The provider organization identifier. Leave blank when the access token already selects it.",
    placeholder: "Optional organization ID",
  },
  token: {
    help: "A restricted provider token created for this connection. OpenSesame seals it immediately.",
    placeholder: "Paste token once",
  },
  host: {
    help: "The self-hosted service address. Leave blank to use the provider's hosted default.",
    placeholder: "https://secrets.example.com",
  },
  server_url: {
    help: "Your Bitwarden or Vaultwarden server URL. Leave blank for Bitwarden Cloud.",
    placeholder: "https://vault.example.com",
  },
  vault: {
    help: "The vault name or identifier to use by default. Leave blank to choose it per secret reference.",
    placeholder: "Engineering",
  },
  service: {
    help: "The service name used to namespace entries in the operating-system keychain.",
    placeholder: "opensesame",
  },
  database_path: {
    help: "An absolute path on the Host machine to the KeePass .kdbx database.",
    placeholder: "/home/user/secrets.kdbx",
  },
  password: {
    help: "The database password. OpenSesame seals it and never returns it to the browser.",
    placeholder: "Paste database password once",
  },
  store_dir: {
    help: "An absolute path on the Host machine to the password-store directory.",
    placeholder: "/home/user/.password-store",
  },
  namespace: {
    help: "An optional namespace that keeps this connection's entries separate from others.",
    placeholder: "team-name",
  },
  location: {
    help: "The Host path or remote location where encrypted values are stored.",
    placeholder: "/absolute/path or provider location",
  },
  key: {
    help: "The encryption key used for this location. Paste it once; it is sealed immediately.",
    placeholder: "Paste encryption key once",
  },
  address: {
    help: "The full HTTPS address of the Vault or OpenBao server.",
    placeholder: "https://vault.example.com",
  },
  base_url: {
    help: "The full HTTPS base URL of your provider instance, including any API mount path.",
    placeholder: "https://service.example.com/api",
  },
  api_key: {
    help: "A restricted API key created for this connection. It is sealed immediately.",
    placeholder: "Paste API key once",
  },
};

export function connectorSummary(provider: Provider): string {
  return `${CATEGORY_SUMMARY[provider.category]} ${provider.displayName} setup stays in the Host; secret values are never returned to this browser.`;
}

export function connectorSteps(provider: Provider): string[] {
  if (provider.id === "openrouter") {
    return [
      "Choose Connect to open OpenRouter's secure sign-in page.",
      "Approve access; OpenRouter generates a user-controlled API key in the web response.",
      "Return here; OpenSesame seals the generated key without showing it in this page.",
    ];
  }
  if (
    provider.id.startsWith("aws-") ||
    provider.id.startsWith("azure-") ||
    provider.id.startsWith("gcp-")
  ) {
    return [
      `OpenSesame first uses the ${provider.displayName} identity already available to the Host.`,
      "Fill only the resource location and any credential overrides your Host cannot discover.",
      "Save the configuration; no long-lived secret is needed when workload identity is available.",
    ];
  }
  if (["1password", "bitwarden"].includes(provider.id)) {
    return [
      `OpenSesame first reuses the signed-in ${provider.displayName} CLI session on the Host.`,
      "Add a token only when the Host has no delegated session to reuse.",
      "Save the configuration; secret overrides are sealed and never shown again.",
    ];
  }
  if (provider.id === "better-auth") {
    return [
      "Enable Better Auth's API Key plugin and create a least-privilege key for this Host.",
      "Enter the Better Auth base URL and paste the key once.",
      "The default x-api-key header and default configuration ID are filled automatically.",
    ];
  }
  if (provider.id === "auth0") {
    return [
      "Create an Auth0 machine-to-machine application and authorize only the Management API permissions this connection needs.",
      "Enter the tenant domain, client ID, and client secret from that application.",
      "Leave Audience blank to derive the tenant's Management API identifier automatically.",
    ];
  }
  if (provider.authKind === "oauth2_authorization_code") {
    return [
      `Review the access requested from ${provider.displayName}.`,
      `Sign in to ${provider.displayName} in the consent window and approve it.`,
      provider.supportsRefresh
        ? "Return here; OpenSesame renews the authorization when needed."
        : "Return here; reconnect when the provider authorization expires.",
    ];
  }
  if (provider.authKind === "api_key") {
    return [
      `Open the ${provider.displayName} setup guide and create a least-privilege API key.`,
      "Copy the key while the provider still shows it.",
      "Paste it below once; OpenSesame seals it on arrival.",
    ];
  }
  return [
    `Open the ${provider.displayName} setup guide and prepare the required values.`,
    "Enter values from the machine or account the Host will use.",
    "Save once; secret fields are sealed and never shown again.",
  ];
}

export function fieldGuidance(field: ConfigurationField): FieldGuidance {
  if (field.required && field.name === "session_token") {
    return {
      help: "The session token required by this provider. Paste it once; OpenSesame seals it immediately.",
      placeholder: "Paste session token once",
    };
  }
  if (field.required && field.name === "namespace") {
    return {
      help: "The namespace used to keep this connection's entries separate from others.",
      placeholder: "team-name",
    };
  }
  if (!field.required) {
    const delegated: Record<string, FieldGuidance> = {
      region: {
        help: "Leave blank to use the region from the Host's AWS profile, environment, container, or instance identity.",
        placeholder: "Auto-detect from Host",
      },
      access_key_id: {
        help: "Leave blank to use the Host's AWS default credential chain. Supply this only with a matching secret access key.",
        placeholder: "Use Host identity",
      },
      secret_access_key: {
        help: "Leave blank to use the Host's AWS default credential chain. A manual override is sealed immediately.",
        placeholder: "Use Host identity",
      },
      tenant_id: {
        help: "Leave blank to let Azure DefaultAzureCredential select the Host tenant. Override only for a service principal.",
        placeholder: "Auto-detect from Host",
      },
      client_id: {
        help: "Leave blank to use the Host's managed identity or signed-in Azure CLI session.",
        placeholder: "Use Host identity",
      },
      client_secret: {
        help: "Leave blank to use delegated Azure credentials. A service-principal secret override is sealed immediately.",
        placeholder: "Use Host identity",
      },
      project_id: {
        help: "Leave blank to use the project discovered by Google Application Default Credentials.",
        placeholder: "Auto-detect from Host",
      },
      service_account_json: {
        help: "Leave blank to use Google Application Default Credentials from the Host. A JSON override is sealed immediately.",
        placeholder: "Use Host identity",
      },
      service_account_token: {
        help: "Leave blank to reuse the signed-in 1Password CLI session on the Host. A service-account override is sealed immediately.",
        placeholder: "Use Host session",
      },
      session_token: {
        help: "Leave blank to reuse the unlocked Bitwarden CLI session on the Host. A session-token override is sealed immediately.",
        placeholder: "Use Host session",
      },
    };
    if (delegated[field.name]) return delegated[field.name];
  }
  return (
    FIELD_GUIDANCE[field.name] ?? {
      help: `Enter the ${field.label.toLowerCase()} described in the provider setup guide.`,
      placeholder: field.secret
        ? `Paste ${field.label.toLowerCase()} once`
        : field.label,
    }
  );
}

export function configurationDefaults(
  provider: Pick<Provider, "id">,
): Record<string, string> {
  if (provider.id === "keychain") return { service: "opensesame" };
  if (provider.id === "plain") return { namespace: "opensesame" };
  if (provider.id === "better-auth") {
    return { api_key_header: "x-api-key", config_id: "default" };
  }
  return {};
}

export function canConfigureAutomatically(
  provider: Pick<Provider, "autoConfigurable">,
): boolean {
  return provider.autoConfigurable;
}

export function configurationPayload(
  provider: Pick<Provider, "id">,
  values: Record<string, string>,
): Record<string, string> {
  const payload = Object.fromEntries(
    Object.entries(values)
      .map(([key, value]) => [key, value.trim()])
      .filter(([, value]) => value !== ""),
  );
  if (provider.id !== "auth0" || typeof payload.domain !== "string") {
    return payload;
  }
  const domain = payload.domain
    .replace(/^https?:\/\//i, "")
    .replace(/\/+$/, "");
  payload.domain = domain;
  payload.audience ||= `https://${domain}/api/v2/`;
  return payload;
}

export function needsScopeSelection(
  provider: Pick<Provider, "scopes">,
  selected: string[],
): boolean {
  return provider.scopes.length > 0 && selected.length === 0;
}
