//! Provider catalog: data, not code paths (ADR 0032 §3).
//!
//! Every entry declares its endpoints, its scope vocabulary and — the part the
//! rest of the system depends on — the egress allowlist a credential issued for
//! it may reach. Endpoints are copied from provider documentation; a provider
//! whose endpoints are not known belongs outside this table.

use opensesame_domain::EgressBinding;
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, sync::OnceLock, time::Duration};

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Category {
    Encryption,
    CloudSecretStorage,
    PasswordManagers,
    LocalStorage,
    Developer,
    Productivity,
    Communication,
    Storage,
    Crm,
    Payments,
    Identity,
    Testing,
}

impl Category {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Encryption => "encryption",
            Self::CloudSecretStorage => "cloud_secret_storage",
            Self::PasswordManagers => "password_managers",
            Self::LocalStorage => "local_storage",
            Self::Developer => "developer",
            Self::Productivity => "productivity",
            Self::Communication => "communication",
            Self::Storage => "storage",
            Self::Crm => "crm",
            Self::Payments => "payments",
            Self::Identity => "identity",
            Self::Testing => "testing",
        }
    }
}

/// How the token endpoint authenticates the client.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TokenAuth {
    ClientSecretPost,
    ClientSecretBasic,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AuthMethod {
    OAuth2AuthCode {
        authorize_url: &'static str,
        token_url: &'static str,
        revoke_url: Option<&'static str>,
        supports_refresh: bool,
        token_auth: TokenAuth,
        /// Provider-specific parameters without which a refresh token is never
        /// issued (Google's `access_type`, the `offline_access` family).
        extra_authorize_params: &'static [(&'static str, &'static str)],
    },
    /// OpenRouter's browser PKCE flow exchanges a code for a user-controlled
    /// API key without an app registration or client secret.
    OpenRouterPkce {
        authorize_url: &'static str,
        exchange_url: &'static str,
    },
    ApiKey {
        header: &'static str,
        value_prefix: &'static str,
    },
    /// Sealed provider-specific settings. These connectors are configurable in
    /// the Host, but do not pretend a generic HTTP header is their protocol.
    Configuration,
}

impl AuthMethod {
    pub fn kind(&self) -> &'static str {
        match self {
            Self::OAuth2AuthCode { .. } => "oauth2_authorization_code",
            Self::OpenRouterPkce { .. } => "oauth2_authorization_code",
            Self::ApiKey { .. } => "api_key",
            Self::Configuration => "configuration",
        }
    }

    pub fn supports_refresh(&self) -> bool {
        matches!(
            self,
            Self::OAuth2AuthCode {
                supports_refresh: true,
                ..
            }
        )
    }

    pub fn is_oauth(&self) -> bool {
        matches!(
            self,
            Self::OAuth2AuthCode { .. } | Self::OpenRouterPkce { .. }
        )
    }
}

#[derive(Clone, Copy, Debug, Serialize)]
pub struct ConfigurationFieldDef {
    pub name: &'static str,
    pub label: &'static str,
    pub secret: bool,
    pub required: bool,
}

pub fn configuration_fields(provider_id: &str) -> &'static [ConfigurationFieldDef] {
    if let Some(fields) = INSTALLED_CATALOG
        .get()
        .and_then(|catalog| catalog.fields.get(provider_id))
    {
        return fields;
    }
    use ConfigurationFieldDef as Field;
    match provider_id {
        "age" => &[
            Field {
                name: "recipients",
                label: "Recipients",
                secret: false,
                required: true,
            },
            Field {
                name: "identity",
                label: "Identity",
                secret: true,
                required: true,
            },
        ],
        "fido2" => &[
            Field {
                name: "credential_id",
                label: "Credential ID",
                secret: false,
                required: true,
            },
            Field {
                name: "pin",
                label: "PIN",
                secret: true,
                required: false,
            },
        ],
        "yubikey" => &[
            Field {
                name: "recipient",
                label: "Recipient",
                secret: false,
                required: true,
            },
            Field {
                name: "slot",
                label: "Slot",
                secret: false,
                required: false,
            },
            Field {
                name: "pin",
                label: "PIN",
                secret: true,
                required: false,
            },
        ],
        "aws-parameter-store" | "aws-secrets-manager" | "aws-kms" | "aws-bedrock" => AWS_FIELDS,
        "azure-key-vault-keys"
        | "azure-key-vault-secrets"
        | "azure-app-configuration"
        | "azure-openai" => AZURE_FIELDS,
        "gcp-secret-manager" | "gcp-kms" => GCP_FIELDS,
        "bitwarden" => &[
            Field {
                name: "session_token",
                label: "Session token",
                secret: true,
                required: false,
            },
            Field {
                name: "server_url",
                label: "Server URL",
                secret: false,
                required: false,
            },
        ],
        "bitwarden-secrets-manager" => &[
            Field {
                name: "access_token",
                label: "Access token",
                secret: true,
                required: true,
            },
            Field {
                name: "organization_id",
                label: "Organization ID",
                secret: false,
                required: false,
            },
            Field {
                name: "project_id",
                label: "Project ID",
                secret: false,
                required: false,
            },
        ],
        "1password" => &[
            Field {
                name: "service_account_token",
                label: "Service account token",
                secret: true,
                required: false,
            },
            Field {
                name: "vault",
                label: "Vault",
                secret: false,
                required: false,
            },
        ],
        "keychain" => &[Field {
            name: "service",
            label: "Service",
            secret: false,
            required: true,
        }],
        "keepass" => &[
            Field {
                name: "database_path",
                label: "Database path",
                secret: false,
                required: true,
            },
            Field {
                name: "password",
                label: "Password",
                secret: true,
                required: true,
            },
        ],
        "password-store" => &[Field {
            name: "store_dir",
            label: "Store directory",
            secret: false,
            required: true,
        }],
        "plain" => &[Field {
            name: "namespace",
            label: "Namespace",
            secret: false,
            required: true,
        }],
        "sealed-local" | "encrypted-remote" => &[
            Field {
                name: "location",
                label: "Location",
                secret: false,
                required: true,
            },
            Field {
                name: "key",
                label: "Encryption key",
                secret: true,
                required: true,
            },
        ],
        "vault" | "openbao" => &[
            Field {
                name: "address",
                label: "Address",
                secret: false,
                required: true,
            },
            Field {
                name: "token",
                label: "Token",
                secret: true,
                required: true,
            },
            Field {
                name: "namespace",
                label: "Namespace",
                secret: false,
                required: false,
            },
        ],
        "doppler" | "foks" | "infisical" | "proton-pass" | "vaultwarden" => TOKEN_FIELDS,
        "passwordstate" => &[
            Field {
                name: "base_url",
                label: "Base URL",
                secret: false,
                required: true,
            },
            Field {
                name: "api_key",
                label: "API key",
                secret: true,
                required: true,
            },
        ],
        _ => &[],
    }
}

const AWS_FIELDS: &[ConfigurationFieldDef] = &[
    ConfigurationFieldDef {
        name: "region",
        label: "Region",
        secret: false,
        required: false,
    },
    ConfigurationFieldDef {
        name: "access_key_id",
        label: "Access key ID",
        secret: false,
        required: false,
    },
    ConfigurationFieldDef {
        name: "secret_access_key",
        label: "Secret access key",
        secret: true,
        required: false,
    },
    ConfigurationFieldDef {
        name: "session_token",
        label: "Session token",
        secret: true,
        required: false,
    },
];
const AZURE_FIELDS: &[ConfigurationFieldDef] = &[
    ConfigurationFieldDef {
        name: "endpoint",
        label: "Endpoint or vault URL",
        secret: false,
        required: true,
    },
    ConfigurationFieldDef {
        name: "tenant_id",
        label: "Tenant ID",
        secret: false,
        required: false,
    },
    ConfigurationFieldDef {
        name: "client_id",
        label: "Client ID",
        secret: false,
        required: false,
    },
    ConfigurationFieldDef {
        name: "client_secret",
        label: "Client secret",
        secret: true,
        required: false,
    },
];
const GCP_FIELDS: &[ConfigurationFieldDef] = &[
    ConfigurationFieldDef {
        name: "project_id",
        label: "Project ID",
        secret: false,
        required: false,
    },
    ConfigurationFieldDef {
        name: "service_account_json",
        label: "Service account JSON",
        secret: true,
        required: false,
    },
];
const TOKEN_FIELDS: &[ConfigurationFieldDef] = &[
    ConfigurationFieldDef {
        name: "token",
        label: "Token",
        secret: true,
        required: true,
    },
    ConfigurationFieldDef {
        name: "host",
        label: "Host",
        secret: false,
        required: false,
    },
];

#[derive(Clone, Copy, Debug, Serialize)]
pub struct ScopeDef {
    pub name: &'static str,
    pub description: &'static str,
    /// Broad or destructive: the UI must not pre-tick these silently.
    pub sensitive: bool,
    pub default: bool,
}

#[derive(Clone, Copy, Debug)]
pub struct EgressSpec {
    pub scheme: &'static str,
    pub authorities: &'static [&'static str],
    pub path_prefixes: &'static [&'static str],
}

impl EgressSpec {
    pub fn binding(&self) -> EgressBinding {
        EgressBinding {
            scheme: self.scheme.to_string(),
            authorities: self.authorities.iter().map(|a| a.to_string()).collect(),
            path_prefixes: self.path_prefixes.iter().map(|p| p.to_string()).collect(),
            allow_redirects_cross_authority: false,
        }
    }
}

#[derive(Clone, Copy, Debug)]
pub struct Provider {
    pub id: &'static str,
    pub display_name: &'static str,
    pub category: Category,
    pub docs_url: &'static str,
    pub auth: AuthMethod,
    pub scopes: &'static [ScopeDef],
    pub egress: EgressSpec,
    pub operations: &'static [&'static str],
}

impl Provider {
    pub fn default_scopes(&self) -> Vec<String> {
        self.scopes
            .iter()
            .filter(|s| s.default)
            .map(|s| s.name.to_string())
            .collect()
    }
}

pub fn find(id: &str) -> Option<&'static Provider> {
    all().iter().find(|p| p.id == id)
}

pub fn all() -> &'static [Provider] {
    INSTALLED_CATALOG
        .get()
        .map(|catalog| catalog.providers.as_slice())
        .unwrap_or(PROVIDERS)
}

const ENV_CONNECTOR_REGISTRIES: &str = "OPENSESAME_CONNECTOR_REGISTRIES";
const MAX_REGISTRIES: usize = 8;
const MAX_REGISTRY_BYTES: usize = 1024 * 1024;

struct InstalledCatalog {
    providers: Vec<Provider>,
    fields: HashMap<&'static str, &'static [ConfigurationFieldDef]>,
}

static INSTALLED_CATALOG: OnceLock<InstalledCatalog> = OnceLock::new();

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RegistryDocument {
    schema_version: u8,
    providers: Vec<RegistryProvider>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RegistryProvider {
    id: String,
    display_name: String,
    category: Category,
    docs_url: String,
    auth: RegistryAuth,
    #[serde(default)]
    configuration_fields: Vec<RegistryField>,
    egress: RegistryEgress,
    #[serde(default)]
    operations: Vec<String>,
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
enum RegistryAuth {
    ApiKey {
        header: String,
        value_prefix: String,
    },
    Configuration,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RegistryField {
    name: String,
    label: String,
    secret: bool,
    required: bool,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RegistryEgress {
    scheme: String,
    authorities: Vec<String>,
    #[serde(default)]
    path_prefixes: Vec<String>,
}

/// Additive remote catalogs configured by the Host admin. Built-ins always win,
/// and a broken optional registry never removes a built-in connector.
pub async fn load_external_registries_from_env() {
    let Some(raw) = std::env::var(ENV_CONNECTOR_REGISTRIES)
        .ok()
        .filter(|value| !value.trim().is_empty())
    else {
        return;
    };
    let urls: Vec<_> = raw
        .split(',')
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .take(MAX_REGISTRIES)
        .collect();
    let client = match reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .redirect(reqwest::redirect::Policy::none())
        .build()
    {
        Ok(client) => client,
        Err(error) => {
            tracing::warn!(%error, "connector registry client unavailable");
            return;
        }
    };
    let mut providers = PROVIDERS.to_vec();
    let mut fields = HashMap::new();
    for raw_url in urls {
        match fetch_registry(&client, raw_url).await {
            Ok(document) => install_registry(document, &mut providers, &mut fields),
            Err(error) => {
                tracing::warn!(registry = raw_url, %error, "optional connector registry skipped")
            }
        }
    }
    let _ = INSTALLED_CATALOG.set(InstalledCatalog { providers, fields });
}

async fn fetch_registry(
    client: &reqwest::Client,
    raw_url: &str,
) -> anyhow::Result<RegistryDocument> {
    let url = url::Url::parse(raw_url)?;
    let loopback = url.host_str().is_some_and(|host| {
        host == "localhost"
            || host
                .parse::<std::net::IpAddr>()
                .is_ok_and(|ip| ip.is_loopback())
    });
    if url.scheme() != "https" && !(url.scheme() == "http" && loopback) {
        anyhow::bail!("registry URL must use HTTPS (HTTP is allowed only on loopback)");
    }
    if !url.username().is_empty() || url.password().is_some() || url.fragment().is_some() {
        anyhow::bail!("registry URL may not contain credentials or a fragment");
    }
    let response = client.get(url).send().await?.error_for_status()?;
    if response
        .content_length()
        .is_some_and(|size| size > MAX_REGISTRY_BYTES as u64)
    {
        anyhow::bail!("registry exceeds {MAX_REGISTRY_BYTES} bytes");
    }
    let bytes = response.bytes().await?;
    if bytes.len() > MAX_REGISTRY_BYTES {
        anyhow::bail!("registry exceeds {MAX_REGISTRY_BYTES} bytes");
    }
    let document: RegistryDocument = serde_json::from_slice(&bytes)?;
    if document.schema_version != 1 {
        anyhow::bail!("unsupported connector registry schema_version");
    }
    Ok(document)
}

fn install_registry(
    document: RegistryDocument,
    providers: &mut Vec<Provider>,
    fields: &mut HashMap<&'static str, &'static [ConfigurationFieldDef]>,
) {
    for provider in document.providers.into_iter().take(256) {
        if providers.iter().any(|current| current.id == provider.id) {
            continue;
        }
        let Ok((provider, provider_fields)) = leak_registry_provider(provider) else {
            continue;
        };
        if !provider_fields.is_empty() {
            fields.insert(provider.id, provider_fields);
        }
        providers.push(provider);
    }
}

fn leak_registry_provider(
    provider: RegistryProvider,
) -> anyhow::Result<(Provider, &'static [ConfigurationFieldDef])> {
    if provider.id.is_empty()
        || provider.id.len() > 64
        || !provider
            .id
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
        || provider.display_name.trim().is_empty()
        || provider.display_name.len() > 96
    {
        anyhow::bail!("invalid provider identity");
    }
    let docs = url::Url::parse(&provider.docs_url)?;
    if docs.scheme() != "https" || !docs.username().is_empty() || docs.password().is_some() {
        anyhow::bail!("provider docs_url must use HTTPS");
    }
    if provider.operations.is_empty()
        || provider.operations.len() > 64
        || provider
            .operations
            .iter()
            .any(|operation| operation.is_empty() || operation.len() > 96)
    {
        anyhow::bail!("provider must declare bounded operations");
    }
    if provider
        .egress
        .path_prefixes
        .iter()
        .any(|path| path.len() > 256 || !path.starts_with('/') || path.contains(".."))
    {
        anyhow::bail!("invalid egress path prefix");
    }
    let auth = match provider.auth {
        RegistryAuth::ApiKey {
            header,
            value_prefix,
        } => {
            if header.is_empty()
                || reqwest::header::HeaderName::from_bytes(header.as_bytes()).is_err()
                || value_prefix.len() > 64
                || provider.egress.scheme != "https"
                || provider.egress.authorities.is_empty()
            {
                anyhow::bail!("API-key providers require a header and HTTPS egress authorities");
            }
            AuthMethod::ApiKey {
                header: leak(header),
                value_prefix: leak(value_prefix),
            }
        }
        RegistryAuth::Configuration => {
            if provider.configuration_fields.is_empty()
                || provider.egress.scheme != "none"
                || !provider.egress.authorities.is_empty()
            {
                anyhow::bail!("configuration providers require fields and no HTTP egress");
            }
            AuthMethod::Configuration
        }
    };
    for authority in &provider.egress.authorities {
        let parsed = url::Url::parse(&format!("https://{authority}"))?;
        if parsed.host_str().is_none()
            || !parsed.username().is_empty()
            || parsed.password().is_some()
            || parsed.path() != "/"
        {
            anyhow::bail!("invalid egress authority");
        }
    }
    let mut field_names = std::collections::HashSet::new();
    for field in &provider.configuration_fields {
        if field.name.is_empty()
            || field.name.len() > 64
            || !field.name.bytes().all(|byte| {
                byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_' || byte == b'-'
            })
            || field.label.trim().is_empty()
            || field.label.len() > 96
            || !field_names.insert(field.name.as_str())
        {
            anyhow::bail!("invalid configuration field");
        }
    }
    let provider_fields: &'static [ConfigurationFieldDef] = Box::leak(
        provider
            .configuration_fields
            .into_iter()
            .take(32)
            .map(|field| ConfigurationFieldDef {
                name: leak(field.name),
                label: leak(field.label),
                secret: field.secret,
                required: field.required,
            })
            .collect::<Vec<_>>()
            .into_boxed_slice(),
    );
    let authorities = leak_strings(provider.egress.authorities);
    let path_prefixes = leak_strings(provider.egress.path_prefixes);
    let operations = leak_strings(provider.operations);
    Ok((
        Provider {
            id: leak(provider.id),
            display_name: leak(provider.display_name),
            category: provider.category,
            docs_url: leak(provider.docs_url),
            auth,
            scopes: &[],
            egress: EgressSpec {
                scheme: leak(provider.egress.scheme),
                authorities,
                path_prefixes,
            },
            operations,
        },
        provider_fields,
    ))
}

// ponytail: startup-only bounded leaks keep the catalog's existing static data model;
// move Provider to owned strings only if registries become hot-reloadable.
fn leak(value: String) -> &'static str {
    Box::leak(value.into_boxed_str())
}

fn leak_strings(values: Vec<String>) -> &'static [&'static str] {
    Box::leak(
        values
            .into_iter()
            .take(64)
            .map(leak)
            .collect::<Vec<_>>()
            .into_boxed_slice(),
    )
}

/// Loopback default for the bundled mock authorization server; overridden per
/// deployment by `OPENSESAME_PROVIDER_MOCK_AUTHORIZE_URL` / `_TOKEN_URL`.
pub const MOCK_AUTHORIZE_URL: &str = "http://127.0.0.1:9090/authorize";
pub const MOCK_TOKEN_URL: &str = "http://127.0.0.1:9090/token";

const OFFLINE_ACCESS: &[(&str, &str)] = &[];

macro_rules! configuration_provider {
    ($id:literal, $name:literal, $category:expr, $docs:literal) => {
        Provider {
            id: $id,
            display_name: $name,
            category: $category,
            docs_url: $docs,
            auth: AuthMethod::Configuration,
            scopes: &[],
            egress: EgressSpec {
                scheme: "none",
                authorities: &[],
                path_prefixes: &[],
            },
            operations: &["secret.configure"],
        }
    };
}

macro_rules! api_key_provider {
    ($id:literal, $name:literal, $docs:literal, $header:literal, $prefix:literal, $authority:literal) => {
        Provider {
            id: $id,
            display_name: $name,
            category: Category::Developer,
            docs_url: $docs,
            auth: AuthMethod::ApiKey {
                header: $header,
                value_prefix: $prefix,
            },
            scopes: &[],
            egress: EgressSpec {
                scheme: "https",
                authorities: &[$authority],
                path_prefixes: &[],
            },
            operations: &["model.invoke"],
        }
    };
}

static PROVIDERS: &[Provider] = &[
    Provider {
        id: "github",
        display_name: "GitHub",
        category: Category::Developer,
        docs_url: "https://docs.github.com/apps/oauth-apps",
        auth: AuthMethod::OAuth2AuthCode {
            authorize_url: "https://github.com/login/oauth/authorize",
            token_url: "https://github.com/login/oauth/access_token",
            revoke_url: None,
            supports_refresh: false,
            token_auth: TokenAuth::ClientSecretPost,
            extra_authorize_params: OFFLINE_ACCESS,
        },
        scopes: &[
            ScopeDef {
                name: "read:user",
                description: "Read the authenticated user's profile",
                sensitive: false,
                default: true,
            },
            ScopeDef {
                name: "repo",
                description: "Full read and write access to private repositories",
                sensitive: true,
                default: false,
            },
            ScopeDef {
                name: "read:org",
                description: "Read organization membership and teams",
                sensitive: false,
                default: false,
            },
            ScopeDef {
                name: "workflow",
                description: "Update GitHub Actions workflow files",
                sensitive: true,
                default: false,
            },
        ],
        egress: EgressSpec {
            scheme: "https",
            authorities: &["api.github.com"],
            path_prefixes: &[],
        },
        operations: &["repository.read", "pull_request.create", "issue.create"],
    },
    Provider {
        id: "gitlab",
        display_name: "GitLab",
        category: Category::Developer,
        docs_url: "https://docs.gitlab.com/ee/api/oauth2.html",
        auth: AuthMethod::OAuth2AuthCode {
            authorize_url: "https://gitlab.com/oauth/authorize",
            token_url: "https://gitlab.com/oauth/token",
            revoke_url: Some("https://gitlab.com/oauth/revoke"),
            supports_refresh: true,
            token_auth: TokenAuth::ClientSecretPost,
            extra_authorize_params: OFFLINE_ACCESS,
        },
        scopes: &[
            ScopeDef {
                name: "read_user",
                description: "Read the authenticated user's profile",
                sensitive: false,
                default: true,
            },
            ScopeDef {
                name: "read_repository",
                description: "Read repository files and metadata",
                sensitive: false,
                default: false,
            },
            ScopeDef {
                name: "api",
                description: "Full read and write access to the GitLab API",
                sensitive: true,
                default: false,
            },
        ],
        egress: EgressSpec {
            scheme: "https",
            authorities: &["gitlab.com"],
            path_prefixes: &[],
        },
        operations: &["project.read", "merge_request.create", "issue.create"],
    },
    Provider {
        id: "google",
        display_name: "Google",
        category: Category::Productivity,
        docs_url: "https://developers.google.com/identity/protocols/oauth2/web-server",
        auth: AuthMethod::OAuth2AuthCode {
            authorize_url: "https://accounts.google.com/o/oauth2/v2/auth",
            token_url: "https://oauth2.googleapis.com/token",
            revoke_url: Some("https://oauth2.googleapis.com/revoke"),
            supports_refresh: true,
            token_auth: TokenAuth::ClientSecretPost,
            // Google issues a refresh token only on the first consent unless both are sent.
            extra_authorize_params: &[("access_type", "offline"), ("prompt", "consent")],
        },
        scopes: &[
            ScopeDef {
                name: "openid",
                description: "Identify the signed-in account",
                sensitive: false,
                default: true,
            },
            ScopeDef {
                name: "email",
                description: "Read the account's email address",
                sensitive: false,
                default: true,
            },
            ScopeDef {
                name: "https://www.googleapis.com/auth/drive.readonly",
                description: "Read all files in Google Drive",
                sensitive: true,
                default: false,
            },
            ScopeDef {
                name: "https://www.googleapis.com/auth/gmail.readonly",
                description: "Read all Gmail messages and settings",
                sensitive: true,
                default: false,
            },
            ScopeDef {
                name: "https://www.googleapis.com/auth/calendar.readonly",
                description: "Read calendars and events",
                sensitive: false,
                default: false,
            },
        ],
        egress: EgressSpec {
            scheme: "https",
            authorities: &[
                "www.googleapis.com",
                "gmail.googleapis.com",
                "oauth2.googleapis.com",
            ],
            path_prefixes: &[],
        },
        operations: &[
            "drive.file.read",
            "gmail.message.read",
            "calendar.event.read",
        ],
    },
    Provider {
        id: "microsoft",
        display_name: "Microsoft",
        category: Category::Productivity,
        docs_url: "https://learn.microsoft.com/entra/identity-platform/v2-oauth2-auth-code-flow",
        auth: AuthMethod::OAuth2AuthCode {
            authorize_url: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
            token_url: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
            revoke_url: None,
            supports_refresh: true,
            token_auth: TokenAuth::ClientSecretPost,
            extra_authorize_params: OFFLINE_ACCESS,
        },
        scopes: &[
            ScopeDef {
                name: "offline_access",
                description: "Keep access when the user is not present (refresh token)",
                sensitive: false,
                default: true,
            },
            ScopeDef {
                name: "User.Read",
                description: "Read the signed-in user's profile",
                sensitive: false,
                default: true,
            },
            ScopeDef {
                name: "Mail.Read",
                description: "Read the signed-in user's mail",
                sensitive: true,
                default: false,
            },
            ScopeDef {
                name: "Files.Read.All",
                description: "Read all files the signed-in user can access",
                sensitive: true,
                default: false,
            },
        ],
        egress: EgressSpec {
            scheme: "https",
            authorities: &["graph.microsoft.com"],
            path_prefixes: &[],
        },
        operations: &["user.read", "mail.message.read", "drive.file.read"],
    },
    Provider {
        id: "slack",
        display_name: "Slack",
        category: Category::Communication,
        docs_url: "https://api.slack.com/authentication/oauth-v2",
        auth: AuthMethod::OAuth2AuthCode {
            authorize_url: "https://slack.com/oauth/v2/authorize",
            token_url: "https://slack.com/api/oauth.v2.access",
            revoke_url: None,
            supports_refresh: false,
            token_auth: TokenAuth::ClientSecretPost,
            extra_authorize_params: OFFLINE_ACCESS,
        },
        scopes: &[
            ScopeDef {
                name: "chat:write",
                description: "Post messages as the app",
                sensitive: false,
                default: true,
            },
            ScopeDef {
                name: "channels:read",
                description: "List public channels and their metadata",
                sensitive: false,
                default: true,
            },
            ScopeDef {
                name: "users:read",
                description: "List workspace members",
                sensitive: false,
                default: false,
            },
            ScopeDef {
                name: "files:read",
                description: "Read files shared in the workspace",
                sensitive: true,
                default: false,
            },
        ],
        egress: EgressSpec {
            scheme: "https",
            authorities: &["slack.com"],
            path_prefixes: &[],
        },
        operations: &["message.post", "channel.list", "user.list"],
    },
    Provider {
        id: "notion",
        display_name: "Notion",
        category: Category::Productivity,
        docs_url: "https://developers.notion.com/docs/authorization",
        auth: AuthMethod::OAuth2AuthCode {
            authorize_url: "https://api.notion.com/v1/oauth/authorize",
            token_url: "https://api.notion.com/v1/oauth/token",
            revoke_url: None,
            supports_refresh: false,
            token_auth: TokenAuth::ClientSecretBasic,
            extra_authorize_params: &[("owner", "user")],
        },
        // Notion grants capabilities per integration at consent time and rejects a
        // `scope` parameter, so there is no scope vocabulary to offer here.
        scopes: &[],
        egress: EgressSpec {
            scheme: "https",
            authorities: &["api.notion.com"],
            path_prefixes: &[],
        },
        operations: &["page.read", "database.query", "page.create"],
    },
    Provider {
        id: "linear",
        display_name: "Linear",
        category: Category::Productivity,
        docs_url: "https://developers.linear.app/docs/oauth/authentication",
        auth: AuthMethod::OAuth2AuthCode {
            authorize_url: "https://linear.app/oauth/authorize",
            token_url: "https://api.linear.app/oauth/token",
            revoke_url: Some("https://api.linear.app/oauth/revoke"),
            supports_refresh: false,
            token_auth: TokenAuth::ClientSecretPost,
            extra_authorize_params: OFFLINE_ACCESS,
        },
        scopes: &[
            ScopeDef {
                name: "read",
                description: "Read issues, projects and teams",
                sensitive: false,
                default: true,
            },
            ScopeDef {
                name: "write",
                description: "Create and update issues and comments",
                sensitive: false,
                default: false,
            },
            ScopeDef {
                name: "issues:create",
                description: "Create issues only",
                sensitive: false,
                default: false,
            },
            ScopeDef {
                name: "admin",
                description: "Full administrative access to the workspace",
                sensitive: true,
                default: false,
            },
        ],
        egress: EgressSpec {
            scheme: "https",
            authorities: &["api.linear.app"],
            path_prefixes: &[],
        },
        operations: &["issue.read", "issue.create", "project.read"],
    },
    Provider {
        id: "atlassian",
        display_name: "Atlassian",
        category: Category::Productivity,
        docs_url: "https://developer.atlassian.com/cloud/jira/platform/oauth-2-3lo-apps/",
        auth: AuthMethod::OAuth2AuthCode {
            authorize_url: "https://auth.atlassian.com/authorize",
            token_url: "https://auth.atlassian.com/oauth/token",
            revoke_url: None,
            supports_refresh: true,
            token_auth: TokenAuth::ClientSecretPost,
            // Atlassian requires an explicit audience and consent prompt on 3LO.
            extra_authorize_params: &[("audience", "api.atlassian.com"), ("prompt", "consent")],
        },
        scopes: &[
            ScopeDef {
                name: "offline_access",
                description: "Keep access when the user is not present (refresh token)",
                sensitive: false,
                default: true,
            },
            ScopeDef {
                name: "read:me",
                description: "Read the authenticated user's profile",
                sensitive: false,
                default: true,
            },
            ScopeDef {
                name: "read:jira-work",
                description: "Read Jira issues, projects and worklogs",
                sensitive: false,
                default: false,
            },
            ScopeDef {
                name: "write:jira-work",
                description: "Create and update Jira issues",
                sensitive: true,
                default: false,
            },
        ],
        egress: EgressSpec {
            scheme: "https",
            authorities: &["api.atlassian.com"],
            path_prefixes: &[],
        },
        operations: &["issue.read", "issue.create", "project.read"],
    },
    Provider {
        id: "hubspot",
        display_name: "HubSpot",
        category: Category::Crm,
        docs_url: "https://developers.hubspot.com/docs/api/working-with-oauth",
        auth: AuthMethod::OAuth2AuthCode {
            authorize_url: "https://app.hubspot.com/oauth/authorize",
            token_url: "https://api.hubapi.com/oauth/v1/token",
            revoke_url: None,
            supports_refresh: true,
            token_auth: TokenAuth::ClientSecretPost,
            extra_authorize_params: OFFLINE_ACCESS,
        },
        scopes: &[
            ScopeDef {
                name: "oauth",
                description: "Identify the connected HubSpot account",
                sensitive: false,
                default: true,
            },
            ScopeDef {
                name: "crm.objects.contacts.read",
                description: "Read contact records",
                sensitive: false,
                default: true,
            },
            ScopeDef {
                name: "crm.objects.contacts.write",
                description: "Create and update contact records",
                sensitive: true,
                default: false,
            },
            ScopeDef {
                name: "crm.objects.deals.read",
                description: "Read deal records",
                sensitive: false,
                default: false,
            },
        ],
        egress: EgressSpec {
            scheme: "https",
            authorities: &["api.hubapi.com"],
            path_prefixes: &[],
        },
        operations: &["contact.read", "contact.create", "deal.read"],
    },
    Provider {
        id: "salesforce",
        display_name: "Salesforce",
        category: Category::Crm,
        docs_url:
            "https://help.salesforce.com/s/articleView?id=sf.remoteaccess_oauth_web_server_flow.htm",
        auth: AuthMethod::OAuth2AuthCode {
            authorize_url: "https://login.salesforce.com/services/oauth2/authorize",
            token_url: "https://login.salesforce.com/services/oauth2/token",
            revoke_url: Some("https://login.salesforce.com/services/oauth2/revoke"),
            supports_refresh: true,
            token_auth: TokenAuth::ClientSecretPost,
            extra_authorize_params: OFFLINE_ACCESS,
        },
        scopes: &[
            ScopeDef {
                name: "api",
                description: "Access and manage data through the Salesforce APIs",
                sensitive: false,
                default: true,
            },
            ScopeDef {
                name: "refresh_token",
                description: "Keep access when the user is not present (refresh token)",
                sensitive: false,
                default: true,
            },
            ScopeDef {
                name: "openid",
                description: "Identify the signed-in user",
                sensitive: false,
                default: false,
            },
            ScopeDef {
                name: "full",
                description: "Full access to all data the user can reach",
                sensitive: true,
                default: false,
            },
        ],
        egress: EgressSpec {
            scheme: "https",
            authorities: &["login.salesforce.com"],
            path_prefixes: &[],
        },
        operations: &["record.read", "record.create", "soql.query"],
    },
    Provider {
        id: "zoom",
        display_name: "Zoom",
        category: Category::Communication,
        docs_url: "https://developers.zoom.us/docs/integrations/oauth/",
        auth: AuthMethod::OAuth2AuthCode {
            authorize_url: "https://zoom.us/oauth/authorize",
            token_url: "https://zoom.us/oauth/token",
            revoke_url: Some("https://zoom.us/oauth/revoke"),
            supports_refresh: true,
            token_auth: TokenAuth::ClientSecretBasic,
            extra_authorize_params: OFFLINE_ACCESS,
        },
        scopes: &[
            ScopeDef {
                name: "user:read",
                description: "Read the authenticated user's profile",
                sensitive: false,
                default: true,
            },
            ScopeDef {
                name: "meeting:read",
                description: "Read the user's meetings",
                sensitive: false,
                default: true,
            },
            ScopeDef {
                name: "meeting:write",
                description: "Create, update and delete meetings",
                sensitive: true,
                default: false,
            },
        ],
        egress: EgressSpec {
            scheme: "https",
            authorities: &["api.zoom.us"],
            path_prefixes: &[],
        },
        operations: &["meeting.read", "meeting.create", "user.read"],
    },
    Provider {
        id: "dropbox",
        display_name: "Dropbox",
        category: Category::Storage,
        docs_url: "https://developers.dropbox.com/oauth-guide",
        auth: AuthMethod::OAuth2AuthCode {
            authorize_url: "https://www.dropbox.com/oauth2/authorize",
            token_url: "https://api.dropboxapi.com/oauth2/token",
            revoke_url: None,
            supports_refresh: true,
            token_auth: TokenAuth::ClientSecretPost,
            // Dropbox returns a refresh token only for offline token access.
            extra_authorize_params: &[("token_access_type", "offline")],
        },
        scopes: &[
            ScopeDef {
                name: "account_info.read",
                description: "Read the connected account's profile",
                sensitive: false,
                default: true,
            },
            ScopeDef {
                name: "files.metadata.read",
                description: "List files and folders",
                sensitive: false,
                default: true,
            },
            ScopeDef {
                name: "files.content.read",
                description: "Download file contents",
                sensitive: true,
                default: false,
            },
            ScopeDef {
                name: "files.content.write",
                description: "Upload, edit and delete files",
                sensitive: true,
                default: false,
            },
        ],
        egress: EgressSpec {
            scheme: "https",
            authorities: &["api.dropboxapi.com", "content.dropboxapi.com"],
            path_prefixes: &[],
        },
        operations: &["file.list", "file.read", "file.write"],
    },
    Provider {
        id: "box",
        display_name: "Box",
        category: Category::Storage,
        docs_url: "https://developer.box.com/guides/authentication/oauth2/",
        auth: AuthMethod::OAuth2AuthCode {
            authorize_url: "https://account.box.com/api/oauth2/authorize",
            token_url: "https://api.box.com/oauth2/token",
            revoke_url: Some("https://api.box.com/oauth2/revoke"),
            supports_refresh: true,
            token_auth: TokenAuth::ClientSecretPost,
            extra_authorize_params: OFFLINE_ACCESS,
        },
        scopes: &[
            ScopeDef {
                name: "root_readonly",
                description: "Read all files and folders in the account",
                sensitive: false,
                default: true,
            },
            ScopeDef {
                name: "root_readwrite",
                description: "Read, write and delete all files and folders",
                sensitive: true,
                default: false,
            },
        ],
        egress: EgressSpec {
            scheme: "https",
            authorities: &["api.box.com"],
            path_prefixes: &[],
        },
        operations: &["file.list", "file.read", "file.write"],
    },
    Provider {
        id: "asana",
        display_name: "Asana",
        category: Category::Productivity,
        docs_url: "https://developers.asana.com/docs/oauth",
        auth: AuthMethod::OAuth2AuthCode {
            authorize_url: "https://app.asana.com/-/oauth_authorize",
            token_url: "https://app.asana.com/-/oauth_token",
            revoke_url: None,
            supports_refresh: true,
            token_auth: TokenAuth::ClientSecretPost,
            extra_authorize_params: OFFLINE_ACCESS,
        },
        scopes: &[
            ScopeDef {
                name: "default",
                description: "Full access to everything the authorizing user can reach",
                sensitive: true,
                default: true,
            },
            ScopeDef {
                name: "openid",
                description: "Identify the authorizing user",
                sensitive: false,
                default: false,
            },
            ScopeDef {
                name: "email",
                description: "Read the authorizing user's email address",
                sensitive: false,
                default: false,
            },
        ],
        egress: EgressSpec {
            scheme: "https",
            authorities: &["app.asana.com"],
            path_prefixes: &[],
        },
        operations: &["task.read", "task.create", "project.read"],
    },
    Provider {
        id: "figma",
        display_name: "Figma",
        category: Category::Productivity,
        docs_url: "https://www.figma.com/developers/api#oauth2",
        auth: AuthMethod::OAuth2AuthCode {
            authorize_url: "https://www.figma.com/oauth",
            token_url: "https://api.figma.com/v1/oauth/token",
            revoke_url: None,
            supports_refresh: true,
            token_auth: TokenAuth::ClientSecretBasic,
            extra_authorize_params: OFFLINE_ACCESS,
        },
        scopes: &[
            ScopeDef {
                name: "files:read",
                description: "Read files, projects and components",
                sensitive: false,
                default: true,
            },
            ScopeDef {
                name: "file_comments:write",
                description: "Post comments on files",
                sensitive: false,
                default: false,
            },
        ],
        egress: EgressSpec {
            scheme: "https",
            authorities: &["api.figma.com"],
            path_prefixes: &[],
        },
        operations: &["file.read", "comment.create"],
    },
    Provider {
        id: "discord",
        display_name: "Discord",
        category: Category::Communication,
        docs_url: "https://discord.com/developers/docs/topics/oauth2",
        auth: AuthMethod::OAuth2AuthCode {
            authorize_url: "https://discord.com/oauth2/authorize",
            token_url: "https://discord.com/api/oauth2/token",
            revoke_url: Some("https://discord.com/api/oauth2/token/revoke"),
            supports_refresh: true,
            token_auth: TokenAuth::ClientSecretBasic,
            extra_authorize_params: OFFLINE_ACCESS,
        },
        scopes: &[
            ScopeDef {
                name: "identify",
                description: "Read the authorizing user's account",
                sensitive: false,
                default: true,
            },
            ScopeDef {
                name: "email",
                description: "Read the authorizing user's email address",
                sensitive: false,
                default: false,
            },
            ScopeDef {
                name: "guilds",
                description: "List the guilds the user belongs to",
                sensitive: false,
                default: false,
            },
            ScopeDef {
                name: "bot",
                description: "Add a bot to a guild with the requested permissions",
                sensitive: true,
                default: false,
            },
        ],
        egress: EgressSpec {
            scheme: "https",
            authorities: &["discord.com"],
            path_prefixes: &[],
        },
        operations: &["user.read", "guild.list", "message.post"],
    },
    Provider {
        id: "sentry",
        display_name: "Sentry",
        category: Category::Developer,
        docs_url: "https://docs.sentry.io/api/guides/create-auth-token/",
        auth: AuthMethod::OAuth2AuthCode {
            authorize_url: "https://sentry.io/oauth/authorize/",
            token_url: "https://sentry.io/oauth/token/",
            revoke_url: None,
            supports_refresh: true,
            token_auth: TokenAuth::ClientSecretPost,
            extra_authorize_params: OFFLINE_ACCESS,
        },
        scopes: &[
            ScopeDef {
                name: "org:read",
                description: "Read organization settings and membership",
                sensitive: false,
                default: true,
            },
            ScopeDef {
                name: "project:read",
                description: "Read project settings",
                sensitive: false,
                default: true,
            },
            ScopeDef {
                name: "event:read",
                description: "Read error events and issues",
                sensitive: false,
                default: false,
            },
            ScopeDef {
                name: "project:write",
                description: "Create and modify projects",
                sensitive: true,
                default: false,
            },
        ],
        egress: EgressSpec {
            scheme: "https",
            authorities: &["sentry.io"],
            path_prefixes: &[],
        },
        operations: &["issue.read", "event.read", "project.read"],
    },
    Provider {
        id: "stripe",
        display_name: "Stripe",
        category: Category::Payments,
        docs_url: "https://docs.stripe.com/keys",
        auth: AuthMethod::ApiKey {
            header: "Authorization",
            value_prefix: "Bearer ",
        },
        scopes: &[],
        egress: EgressSpec {
            scheme: "https",
            authorities: &["api.stripe.com"],
            path_prefixes: &[],
        },
        operations: &["customer.read", "charge.read", "invoice.read"],
    },
    Provider {
        id: "openai",
        display_name: "OpenAI",
        category: Category::Developer,
        docs_url: "https://platform.openai.com/docs/api-reference/authentication",
        auth: AuthMethod::ApiKey {
            header: "Authorization",
            value_prefix: "Bearer ",
        },
        scopes: &[],
        egress: EgressSpec {
            scheme: "https",
            authorities: &["api.openai.com"],
            path_prefixes: &[],
        },
        operations: &["completion.create", "embedding.create", "model.list"],
    },
    Provider {
        id: "anthropic",
        display_name: "Anthropic",
        category: Category::Developer,
        docs_url: "https://docs.anthropic.com/en/api/getting-started",
        auth: AuthMethod::ApiKey {
            header: "x-api-key",
            value_prefix: "",
        },
        scopes: &[],
        egress: EgressSpec {
            scheme: "https",
            authorities: &["api.anthropic.com"],
            path_prefixes: &[],
        },
        operations: &["message.create", "model.list"],
    },
    Provider {
        id: "openrouter",
        display_name: "OpenRouter",
        category: Category::Developer,
        docs_url: "https://openrouter.ai/docs/guides/overview/auth/oauth",
        auth: AuthMethod::OpenRouterPkce {
            authorize_url: "https://openrouter.ai/auth",
            exchange_url: "https://openrouter.ai/api/v1/auth/keys",
        },
        scopes: &[],
        egress: EgressSpec {
            scheme: "https",
            authorities: &["openrouter.ai"],
            path_prefixes: &[],
        },
        operations: &["model.invoke"],
    },
    api_key_provider!(
        "huggingface",
        "Hugging Face",
        "https://huggingface.co/docs/inference-providers",
        "Authorization",
        "Bearer ",
        "router.huggingface.co"
    ),
    configuration_provider!(
        "azure-openai",
        "Azure OpenAI",
        Category::Developer,
        "https://learn.microsoft.com/azure/ai-services/openai/reference"
    ),
    configuration_provider!(
        "aws-bedrock",
        "AWS Bedrock",
        Category::Developer,
        "https://docs.aws.amazon.com/bedrock/latest/userguide/api-setup.html"
    ),
    configuration_provider!(
        "age",
        "age",
        Category::Encryption,
        "https://fnox.jdx.dev/providers/age.html"
    ),
    configuration_provider!(
        "fido2",
        "FIDO2",
        Category::Encryption,
        "https://fnox.jdx.dev/providers/fido2.html"
    ),
    configuration_provider!(
        "yubikey",
        "YubiKey",
        Category::Encryption,
        "https://fnox.jdx.dev/providers/yubikey.html"
    ),
    configuration_provider!(
        "aws-kms",
        "AWS KMS",
        Category::Encryption,
        "https://fnox.jdx.dev/providers/aws-kms.html"
    ),
    configuration_provider!(
        "azure-key-vault-keys",
        "Azure Key Vault Keys",
        Category::Encryption,
        "https://fnox.jdx.dev/providers/azure-kms.html"
    ),
    configuration_provider!(
        "gcp-kms",
        "Google Cloud KMS",
        Category::Encryption,
        "https://fnox.jdx.dev/providers/gcp-kms.html"
    ),
    configuration_provider!(
        "aws-parameter-store",
        "AWS Parameter Store",
        Category::CloudSecretStorage,
        "https://fnox.jdx.dev/providers/aws-ps.html"
    ),
    configuration_provider!(
        "aws-secrets-manager",
        "AWS Secrets Manager",
        Category::CloudSecretStorage,
        "https://fnox.jdx.dev/providers/aws-sm.html"
    ),
    configuration_provider!(
        "azure-app-configuration",
        "Azure App Configuration",
        Category::CloudSecretStorage,
        "https://fnox.jdx.dev/providers/azure-ac.html"
    ),
    configuration_provider!(
        "azure-key-vault-secrets",
        "Azure Key Vault Secrets",
        Category::CloudSecretStorage,
        "https://fnox.jdx.dev/providers/azure-sm.html"
    ),
    configuration_provider!(
        "gcp-secret-manager",
        "Google Cloud Secret Manager",
        Category::CloudSecretStorage,
        "https://fnox.jdx.dev/providers/gcp-sm.html"
    ),
    configuration_provider!(
        "doppler",
        "Doppler",
        Category::CloudSecretStorage,
        "https://fnox.jdx.dev/providers/doppler.html"
    ),
    configuration_provider!(
        "foks",
        "FOKS",
        Category::CloudSecretStorage,
        "https://fnox.jdx.dev/providers/foks.html"
    ),
    configuration_provider!(
        "bitwarden-secrets-manager",
        "Bitwarden Secrets Manager",
        Category::CloudSecretStorage,
        "https://fnox.jdx.dev/providers/bitwarden-sm.html"
    ),
    configuration_provider!(
        "vault",
        "HashiCorp Vault",
        Category::CloudSecretStorage,
        "https://fnox.jdx.dev/providers/vault.html"
    ),
    configuration_provider!(
        "openbao",
        "OpenBao",
        Category::CloudSecretStorage,
        "https://fnox.jdx.dev/providers/openbao.html"
    ),
    configuration_provider!(
        "1password",
        "1Password",
        Category::PasswordManagers,
        "https://fnox.jdx.dev/providers/1password.html"
    ),
    configuration_provider!(
        "bitwarden",
        "Bitwarden",
        Category::PasswordManagers,
        "https://fnox.jdx.dev/providers/bitwarden.html"
    ),
    configuration_provider!(
        "vaultwarden",
        "Vaultwarden",
        Category::PasswordManagers,
        "https://fnox.jdx.dev/providers/vaultwarden.html"
    ),
    configuration_provider!(
        "infisical",
        "Infisical",
        Category::PasswordManagers,
        "https://fnox.jdx.dev/providers/infisical.html"
    ),
    configuration_provider!(
        "proton-pass",
        "Proton Pass",
        Category::PasswordManagers,
        "https://fnox.jdx.dev/providers/proton-pass.html"
    ),
    configuration_provider!(
        "passwordstate",
        "Passwordstate",
        Category::PasswordManagers,
        "https://fnox.jdx.dev/cli/provider/add"
    ),
    configuration_provider!(
        "keychain",
        "OS Keychain",
        Category::LocalStorage,
        "https://fnox.jdx.dev/providers/keychain.html"
    ),
    configuration_provider!(
        "keepass",
        "KeePass",
        Category::LocalStorage,
        "https://fnox.jdx.dev/providers/keepass.html"
    ),
    configuration_provider!(
        "password-store",
        "password-store",
        Category::LocalStorage,
        "https://fnox.jdx.dev/providers/password-store.html"
    ),
    configuration_provider!(
        "sealed-local",
        "Sealed local",
        Category::Encryption,
        "https://fnox.jdx.dev/providers/overview"
    ),
    configuration_provider!(
        "encrypted-remote",
        "Encrypted remote",
        Category::CloudSecretStorage,
        "https://fnox.jdx.dev/providers/overview"
    ),
    configuration_provider!(
        "plain",
        "Plain text",
        Category::LocalStorage,
        "https://fnox.jdx.dev/providers/plain.html"
    ),
    Provider {
        id: "mock",
        display_name: "Mock provider (testing)",
        category: Category::Testing,
        docs_url: "https://github.com/Tyler-R-Kendrick/OpenSesame/tree/main/apps/mock-upstream-idp",
        auth: AuthMethod::OAuth2AuthCode {
            authorize_url: MOCK_AUTHORIZE_URL,
            token_url: MOCK_TOKEN_URL,
            revoke_url: None,
            supports_refresh: true,
            token_auth: TokenAuth::ClientSecretPost,
            extra_authorize_params: OFFLINE_ACCESS,
        },
        scopes: &[
            ScopeDef {
                name: "read",
                description: "Read fixtures from the mock upstream",
                sensitive: false,
                default: true,
            },
            ScopeDef {
                name: "write",
                description: "Write fixtures to the mock upstream",
                sensitive: false,
                default: false,
            },
            ScopeDef {
                name: "offline_access",
                description: "Keep access when the user is not present (refresh token)",
                sensitive: false,
                default: true,
            },
        ],
        egress: EgressSpec {
            scheme: "http",
            authorities: &["127.0.0.1"],
            path_prefixes: &[],
        },
        operations: &["fixture.read", "fixture.write"],
    },
];

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn provider_ids_are_unique_and_lookupable() {
        let mut seen = HashSet::new();
        for p in all() {
            assert!(seen.insert(p.id), "duplicate provider id {}", p.id);
            assert_eq!(find(p.id).map(|f| f.id), Some(p.id));
        }
        assert!(find("nope").is_none());
    }

    #[test]
    fn every_provider_has_an_egress_allowlist() {
        for p in all() {
            if !matches!(p.auth, AuthMethod::Configuration) {
                assert!(
                    !p.egress.authorities.is_empty(),
                    "{} has no egress authority; a credential for it could go anywhere",
                    p.id
                );
            }
            assert!(!p.operations.is_empty(), "{} declares no operations", p.id);
            assert!(!p.display_name.is_empty());
            assert!(p.docs_url.starts_with("https://"), "{}", p.id);
        }
    }

    /// Only the loopback mock may speak cleartext; everything else is https.
    #[test]
    fn endpoints_are_https_except_the_mock() {
        for p in all() {
            if let AuthMethod::OAuth2AuthCode {
                authorize_url,
                token_url,
                revoke_url,
                ..
            } = p.auth
            {
                let expect_https = p.id != "mock";
                for url in [Some(authorize_url), Some(token_url), revoke_url]
                    .into_iter()
                    .flatten()
                {
                    if expect_https {
                        assert!(url.starts_with("https://"), "{} endpoint {url}", p.id);
                    } else {
                        assert!(url.starts_with("http://127.0.0.1"), "{url}");
                    }
                }
            }
            if p.id == "mock" {
                assert_eq!(p.egress.scheme, "http");
            } else if !matches!(p.auth, AuthMethod::Configuration) {
                assert_eq!(p.egress.scheme, "https", "{}", p.id);
            } else {
                assert_eq!(p.egress.scheme, "none", "{}", p.id);
            }
        }
    }

    #[test]
    fn scopes_are_described_and_defaults_are_not_sensitive() {
        for p in all() {
            let mut names = HashSet::new();
            for s in p.scopes {
                assert!(names.insert(s.name), "{} repeats scope {}", p.id, s.name);
                assert!(!s.description.is_empty(), "{}/{}", p.id, s.name);
            }
            // Asana's only scope is its all-or-nothing `default`; everywhere else a
            // pre-ticked scope must be a narrow one.
            if p.id != "asana" {
                assert!(
                    p.scopes.iter().filter(|s| s.default).all(|s| !s.sensitive),
                    "{} pre-selects a sensitive scope",
                    p.id
                );
            }
        }
    }

    #[test]
    fn api_key_providers_declare_a_header() {
        for p in all() {
            if let AuthMethod::ApiKey { header, .. } = p.auth {
                assert!(!header.is_empty(), "{}", p.id);
                assert!(p.scopes.is_empty(), "{} is api_key yet lists scopes", p.id);
                assert!(!p.auth.supports_refresh());
            }
        }
    }

    #[test]
    fn egress_binding_denies_other_authorities() {
        let github = find("github").expect("github");
        let egress = github.egress.binding();
        assert!(egress.allows_url("https://api.github.com/user").is_ok());
        assert!(egress.allows_url("https://evil.example/user").is_err());
    }

    #[test]
    fn catalog_covers_fnox_and_requested_llm_providers() {
        let expected: HashSet<_> = include_str!("../../../fnox/connectors/fnox-parity.json")
            .split('"')
            .filter(|value| find(value).is_some())
            .collect();
        assert_eq!(
            expected.len(),
            28,
            "every Fnox provider id must be embedded"
        );
        for id in [
            "anthropic",
            "openai",
            "azure-openai",
            "aws-bedrock",
            "openrouter",
            "huggingface",
        ] {
            assert!(find(id).is_some(), "missing {id}");
        }
    }

    #[test]
    fn fnox_providers_use_the_fnox_category_taxonomy_once() {
        let groups = [
            (
                Category::Encryption,
                &[
                    "age",
                    "fido2",
                    "yubikey",
                    "aws-kms",
                    "azure-key-vault-keys",
                    "gcp-kms",
                    "sealed-local",
                ][..],
            ),
            (
                Category::CloudSecretStorage,
                &[
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
                ][..],
            ),
            (
                Category::PasswordManagers,
                &[
                    "1password",
                    "bitwarden",
                    "vaultwarden",
                    "infisical",
                    "proton-pass",
                    "passwordstate",
                ][..],
            ),
            (
                Category::LocalStorage,
                &["keychain", "keepass", "password-store", "plain"][..],
            ),
        ];
        let mut categorized = HashSet::new();
        for (category, ids) in groups {
            for id in ids {
                assert!(categorized.insert(*id), "{id} is categorized twice");
                assert_eq!(find(id).map(|provider| provider.category), Some(category));
            }
        }
        assert_eq!(categorized.len(), 28);
    }

    #[test]
    fn external_registry_is_additive_and_cannot_replace_built_ins() {
        let document: RegistryDocument = serde_json::from_value(serde_json::json!({
            "schema_version": 1,
            "providers": [
                {
                    "id": "github",
                    "display_name": "Impostor",
                    "category": "developer",
                    "docs_url": "https://example.test/github",
                    "auth": {"kind": "configuration"},
                    "configuration_fields": [],
                    "egress": {"scheme": "none", "authorities": []},
                    "operations": []
                },
                {
                    "id": "private-registry",
                    "display_name": "Private registry connector",
                    "category": "storage",
                    "docs_url": "https://example.test/connector",
                    "auth": {"kind": "configuration"},
                    "configuration_fields": [
                        {"name": "token", "label": "Token", "secret": true, "required": true}
                    ],
                    "egress": {"scheme": "none", "authorities": []},
                    "operations": ["secret.configure"]
                }
            ]
        }))
        .expect("registry");
        let mut providers = PROVIDERS.to_vec();
        let mut fields = HashMap::new();
        install_registry(document, &mut providers, &mut fields);
        assert_eq!(
            providers
                .iter()
                .filter(|provider| provider.id == "github")
                .count(),
            1
        );
        assert!(providers
            .iter()
            .any(|provider| provider.id == "private-registry"));
        assert_eq!(fields["private-registry"][0].name, "token");
    }

    #[tokio::test]
    async fn external_registry_refuses_cleartext_off_loopback() {
        let client = reqwest::Client::new();
        let error = fetch_registry(&client, "http://registry.example/catalog.json")
            .await
            .err()
            .expect("cleartext registry");
        assert!(error.to_string().contains("must use HTTPS"));
    }
}
