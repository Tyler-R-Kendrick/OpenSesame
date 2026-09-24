//! Versioned provider catalog and strict loader (ADR 0032 §3). Empty or
//! invalid catalogs refuse to start.

use std::collections::HashSet;
use std::sync::LazyLock;

use opensesame_domain::EgressBinding;
use serde::{Deserialize, Serialize};
use thiserror::Error;
use url::Url;

const CATALOG_JSON: &str = include_str!("../../../spec/connectors/catalog.json");
pub const CATALOG_SCHEMA_VERSION: u32 = 1;
pub const MOCK_AUTHORIZE_URL: &str = "http://127.0.0.1:9090/authorize";
pub const MOCK_TOKEN_URL: &str = "http://127.0.0.1:9090/token";

#[derive(Clone, Debug, Error, PartialEq, Eq)]
#[error("{0}")]
pub struct CatalogError(String);

impl CatalogError {
    fn invalid(message: impl Into<String>) -> Self {
        Self(message.into())
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ConfigurationFieldDef {
    pub name: String,
    pub secret: bool,
    pub required: bool,
}

static OAUTH_INTEGRATION_FIELDS: LazyLock<Vec<ConfigurationFieldDef>> = LazyLock::new(|| {
    vec![
        ConfigurationFieldDef {
            name: "client_id".into(),
            secret: false,
            required: true,
        },
        ConfigurationFieldDef {
            name: "client_secret".into(),
            secret: true,
            required: true,
        },
        // GitHub App Manifest registration seals its signing material here so
        // the backup actor can mint installation tokens server-side and verify
        // webhooks (ADR 0039). Optional: plain OAuth integrations never set them.
        ConfigurationFieldDef {
            name: "app_id".into(),
            secret: false,
            required: false,
        },
        ConfigurationFieldDef {
            name: "private_key_pem".into(),
            secret: true,
            required: false,
        },
        ConfigurationFieldDef {
            name: "webhook_secret".into(),
            secret: true,
            required: false,
        },
    ]
});
static API_KEY_CONNECTION_FIELDS: LazyLock<Vec<ConfigurationFieldDef>> = LazyLock::new(|| {
    vec![ConfigurationFieldDef {
        name: "api_key".into(),
        secret: true,
        required: true,
    }]
});

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Category {
    Identity,
    BackupRecovery,
    Encryption,
    PasswordManagers,
    AgentHarnesses,
    Networking,
    Wallet,
    CloudSecretStorage,
    LocalStorage,
    Developer,
    Productivity,
    Communication,
    Storage,
    Crm,
    Testing,
    Certificates,
    Custom,
}

impl Category {
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Identity => "identity",
            Self::BackupRecovery => "backup_recovery",
            Self::Encryption => "encryption",
            Self::PasswordManagers => "password_managers",
            Self::AgentHarnesses => "agent_harnesses",
            Self::Networking => "networking",
            Self::Wallet => "wallet",
            Self::CloudSecretStorage => "cloud_secret_storage",
            Self::LocalStorage => "local_storage",
            Self::Developer => "developer",
            Self::Productivity => "productivity",
            Self::Communication => "communication",
            Self::Storage => "storage",
            Self::Crm => "crm",
            Self::Testing => "testing",
            Self::Certificates => "certificates",
            Self::Custom => "custom",
        }
    }
}

/// How the token endpoint authenticates the client.
#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TokenAuth {
    ClientSecretPost,
    ClientSecretBasic,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", deny_unknown_fields)]
pub enum AuthMethod {
    #[serde(rename = "oauth2_authorization_code")]
    OAuth2AuthCode {
        authorize_url: String,
        token_url: String,
        revoke_url: Option<String>,
        supports_refresh: bool,
        token_auth: TokenAuth,
        #[serde(default)]
        scope_separator: Option<String>,
        /// Provider-specific parameters without which a refresh token is never
        /// issued (Google's `access_type`, the `offline_access` family).
        extra_authorize_params: Vec<(String, String)>,
    },
    /// `OpenRouter` exchanges PKCE directly for a user-scoped API key; no app
    /// registration or deployment client secret is involved.
    #[serde(rename = "openrouter_pkce")]
    OpenRouterPkce {
        authorize_url: String,
        exchange_url: String,
    },
    #[serde(rename = "api_key")]
    ApiKey {
        header: String,
        value_prefix: String,
    },
    /// Sealed provider-specific configuration without a generic HTTP auth flow.
    /// Execution adapters are intentionally separate from catalog visibility.
    #[serde(rename = "configuration")]
    Configuration,
}

impl AuthMethod {
    #[must_use]
    pub fn kind(&self) -> &'static str {
        match self {
            Self::OAuth2AuthCode { .. } | Self::OpenRouterPkce { .. } => {
                "oauth2_authorization_code"
            }
            Self::ApiKey { .. } => "api_key",
            Self::Configuration => "configuration",
        }
    }

    #[must_use]
    pub fn supports_refresh(&self) -> bool {
        matches!(
            self,
            Self::OAuth2AuthCode {
                supports_refresh: true,
                ..
            }
        )
    }

    #[must_use]
    pub fn scope_separator(&self) -> &str {
        match self {
            Self::OAuth2AuthCode {
                scope_separator, ..
            } => scope_separator.as_deref().unwrap_or(" "),
            Self::OpenRouterPkce { .. } | Self::ApiKey { .. } | Self::Configuration => " ",
        }
    }

    #[must_use]
    pub fn is_oauth(&self) -> bool {
        matches!(
            self,
            Self::OAuth2AuthCode { .. } | Self::OpenRouterPkce { .. }
        )
    }

    #[must_use]
    pub fn requires_client_credentials(&self) -> bool {
        matches!(self, Self::OAuth2AuthCode { .. })
    }

    pub fn integration_configuration_fields(&self) -> &[ConfigurationFieldDef] {
        match self {
            Self::OAuth2AuthCode { .. } => OAUTH_INTEGRATION_FIELDS.as_slice(),
            Self::OpenRouterPkce { .. } | Self::ApiKey { .. } | Self::Configuration => &[],
        }
    }

    pub fn connection_configuration_fields(&self) -> &[ConfigurationFieldDef] {
        match self {
            Self::OAuth2AuthCode { .. } | Self::OpenRouterPkce { .. } | Self::Configuration => &[],
            Self::ApiKey { .. } => API_KEY_CONNECTION_FIELDS.as_slice(),
        }
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ScopeDef {
    pub name: String,
    pub description: String,
    /// Broad or destructive: the UI must not pre-tick these silently.
    pub sensitive: bool,
    pub default: bool,
}

/// A read-only endpoint that answers "does this credential still work?".
///
/// Deliberately narrow: `GET` only, no body, no query, and the host comes from
/// the provider's own `egress.authorities` rather than from this block — so a
/// verify entry can never reach a host the provider's egress does not already
/// name.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct VerifySpec {
    /// Absolute path on the provider's first egress authority.
    pub path: String,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct EgressSpec {
    pub scheme: String,
    pub authorities: Vec<String>,
    pub path_prefixes: Vec<String>,
}

impl EgressSpec {
    #[must_use]
    pub fn binding(&self) -> EgressBinding {
        EgressBinding {
            scheme: self.scheme.clone(),
            authorities: self.authorities.clone(),
            path_prefixes: self.path_prefixes.clone(),
            allow_redirects_cross_authority: false,
        }
    }
}

/// How an upload names its destination path (ADR 0065 §6). Data, not code:
/// the gateway renders the request; a descriptor can never widen egress
/// because `validate_provider` requires the URL inside the row's egress.
#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "snake_case")]
pub enum PathPlacement {
    /// The path rides a JSON-valued header (Dropbox's `Dropbox-API-Arg`).
    /// `template` is a JSON string containing the literal `{path}`.
    HeaderJson { header: String, template: String },
    /// The path is appended to the URL under `prefix`.
    UrlPath { prefix: String },
    /// The path is a query parameter.
    Query { param: String },
}

/// Declarative upload shape for providers that can receive sealed
/// attachment/backup ciphertext. Tier 1 extensibility: adding a storage
/// provider is a catalog row, not a code path.
#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct AttachmentUploadShape {
    pub url: String,
    pub path_placement: PathPlacement,
    #[serde(default)]
    pub extra_headers: Vec<(String, String)>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Provider {
    pub id: String,
    /// Other names the same provider goes by (fnox's long type names, for
    /// one). Every target resolves an id through [`Catalog::resolve`], so an
    /// alias can never become a second row.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub aliases: Vec<String>,
    pub display_name: String,
    pub category: Category,
    pub docs_url: String,
    pub provenance_url: String,
    pub auth: AuthMethod,
    pub scopes: Vec<ScopeDef>,
    pub egress: EgressSpec,
    pub operations: Vec<String>,
    /// Present when the provider can receive sealed uploads (ADR 0065 §6).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attachment_upload: Option<AttachmentUploadShape>,
    /// Present when the provider exposes a side-effect-free authenticated
    /// endpoint that proves a credential works (ADR 0076). Absent means
    /// rotation records an honest `verify_skipped`, never a guessed endpoint:
    /// an invented path turns a verification into a false negative, which is
    /// worse than admitting we cannot check.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub verify: Option<VerifySpec>,
    #[serde(default)]
    pub integration_configuration_fields: Vec<ConfigurationFieldDef>,
    #[serde(default)]
    pub connection_configuration_fields: Vec<ConfigurationFieldDef>,
}

impl Provider {
    #[must_use]
    pub fn default_scopes(&self) -> Vec<String> {
        self.scopes
            .iter()
            .filter(|scope| scope.default)
            .map(|scope| scope.name.clone())
            .collect()
    }

    #[must_use]
    pub fn integration_configuration_fields(&self) -> &[ConfigurationFieldDef] {
        if self.integration_configuration_fields.is_empty() {
            self.auth.integration_configuration_fields()
        } else {
            &self.integration_configuration_fields
        }
    }

    #[must_use]
    pub fn connection_configuration_fields(&self) -> &[ConfigurationFieldDef] {
        if self.connection_configuration_fields.is_empty() {
            self.auth.connection_configuration_fields()
        } else {
            &self.connection_configuration_fields
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct CatalogDocument {
    schema_version: u32,
    revision: String,
    providers: Vec<Provider>,
}

#[derive(Debug)]
pub struct Catalog {
    revision: String,
    providers: Vec<Provider>,
}

impl Catalog {
    /// Parse an untrusted catalog document. Unknown versions, empty provider
    /// lists, and duplicate ids are errors — never a silent empty catalog.
    ///
    /// # Errors
    ///
    /// Returns an error when parsing or catalog validation fails.
    pub fn parse(raw: &str) -> Result<Self, CatalogError> {
        let document: CatalogDocument = serde_json::from_str(raw)
            .map_err(|error| CatalogError::invalid(format!("catalog JSON is invalid: {error}")))?;
        if document.schema_version != CATALOG_SCHEMA_VERSION {
            return Err(CatalogError::invalid(format!(
                "unsupported catalog schema version {}",
                document.schema_version
            )));
        }
        validate_token(&document.revision, "catalog revision", 128)?;
        if document.providers.is_empty() {
            return Err(CatalogError::invalid("catalog has no providers"));
        }
        if document.providers.len() > 2_048 {
            return Err(CatalogError::invalid("catalog has too many providers"));
        }

        let mut ids = HashSet::with_capacity(document.providers.len());
        for provider in &document.providers {
            validate_provider(provider)?;
            if !ids.insert(provider.id.as_str()) {
                return Err(CatalogError::invalid(format!(
                    "duplicate provider id `{}`",
                    provider.id
                )));
            }
        }
        let aliases = document.providers.iter().flat_map(|p| &p.aliases);
        for alias in aliases {
            validate_id(alias)?;
            if !ids.insert(alias.as_str()) {
                return Err(CatalogError::invalid(format!(
                    "provider alias `{alias}` repeats an id or alias"
                )));
            }
        }

        Ok(Self {
            revision: document.revision,
            providers: document.providers,
        })
    }

    #[must_use]
    pub fn revision(&self) -> &str {
        &self.revision
    }

    #[must_use]
    pub fn providers(&self) -> &[Provider] {
        &self.providers
    }

    #[must_use]
    pub fn find(&self, id: &str) -> Option<&Provider> {
        self.providers.iter().find(|provider| provider.id == id)
    }

    /// The row an id or one of its aliases names.
    #[must_use]
    pub fn resolve(&self, id_or_alias: &str) -> Option<&Provider> {
        self.find(id_or_alias).or_else(|| {
            self.providers
                .iter()
                .find(|provider| provider.aliases.iter().any(|alias| alias == id_or_alias))
        })
    }
}

static CATALOG: LazyLock<Result<Catalog, CatalogError>> =
    LazyLock::new(|| Catalog::parse(CATALOG_JSON));

/// # Errors
///
/// Returns the catalog validation error when the bundled catalog is invalid.
pub fn load() -> Result<&'static Catalog, CatalogError> {
    CATALOG.as_ref().map_err(Clone::clone)
}

/// # Errors
///
/// Returns the catalog validation error when the bundled catalog is invalid.
pub fn all() -> Result<&'static [Provider], CatalogError> {
    Ok(load()?.providers())
}

/// # Errors
///
/// Returns the catalog validation error when the bundled catalog is invalid.
pub fn find(id: &str) -> Result<Option<&'static Provider>, CatalogError> {
    Ok(load()?.find(id))
}

/// # Errors
///
/// Returns the catalog validation error when the bundled catalog is invalid.
pub fn resolve(id_or_alias: &str) -> Result<Option<&'static Provider>, CatalogError> {
    Ok(load()?.resolve(id_or_alias))
}

/// # Errors
///
/// Returns the catalog validation error when the bundled catalog is invalid.
pub fn revision() -> Result<&'static str, CatalogError> {
    Ok(load()?.revision())
}

fn validate_provider(provider: &Provider) -> Result<(), CatalogError> {
    validate_id(&provider.id)?;
    validate_text(&provider.display_name, "display_name", 128)?;
    validate_https_url(&provider.docs_url, "docs_url")?;
    validate_https_url(&provider.provenance_url, "provenance_url")?;
    validate_auth(provider)?;
    validate_scopes(provider)?;
    validate_egress(provider)?;
    if provider.category != Category::Wallet || !provider.operations.is_empty() {
        validate_unique_values(&provider.operations, "operation", 128, 128)?;
    }
    validate_attachment_upload(provider)?;
    Ok(())
}

fn validate_attachment_upload(provider: &Provider) -> Result<(), CatalogError> {
    let Some(shape) = &provider.attachment_upload else {
        return Ok(());
    };
    validate_provider_url(provider, &shape.url, "attachment_upload.url")?;
    // A descriptor can never widen egress: its URL must already be inside
    // the row's egress binding.
    provider
        .egress
        .binding()
        .allows_url(&shape.url)
        .map_err(|_| {
            provider_error(
                provider,
                "attachment_upload.url must sit inside the provider egress".to_string(),
            )
        })?;
    match &shape.path_placement {
        PathPlacement::HeaderJson { header, template } => {
            if header.is_empty()
                || header.len() > 64
                || !header
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '-')
            {
                return Err(provider_error(
                    provider,
                    "attachment_upload header must be an HTTP token".to_string(),
                ));
            }
            if !template.contains("{path}") {
                return Err(provider_error(
                    provider,
                    "attachment_upload template must contain {path}".to_string(),
                ));
            }
            let rendered = template.replace("{path}", "probe");
            if serde_json::from_str::<serde_json::Value>(&rendered).is_err() {
                return Err(provider_error(
                    provider,
                    "attachment_upload template must render to JSON".to_string(),
                ));
            }
        }
        PathPlacement::UrlPath { prefix } => {
            if !prefix.starts_with('/') {
                return Err(provider_error(
                    provider,
                    "attachment_upload prefix must start with /".to_string(),
                ));
            }
        }
        PathPlacement::Query { param } => {
            if param.is_empty() || !param.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
                return Err(provider_error(
                    provider,
                    "attachment_upload query param must be alphanumeric".to_string(),
                ));
            }
        }
    }
    for (name, _) in &shape.extra_headers {
        if name.eq_ignore_ascii_case("authorization") || name.eq_ignore_ascii_case("cookie") {
            return Err(provider_error(
                provider,
                "attachment_upload may not carry credential headers".to_string(),
            ));
        }
    }
    Ok(())
}

fn validate_auth(provider: &Provider) -> Result<(), CatalogError> {
    match &provider.auth {
        AuthMethod::OAuth2AuthCode {
            authorize_url,
            token_url,
            revoke_url,
            extra_authorize_params,
            scope_separator,
            ..
        } => {
            validate_provider_url(provider, authorize_url, "authorize_url")?;
            validate_provider_url(provider, token_url, "token_url")?;
            if let Some(url) = revoke_url {
                validate_provider_url(provider, url, "revoke_url")?;
            }
            if extra_authorize_params.len() > 32 {
                return Err(provider_error(
                    provider,
                    "too many authorization parameters",
                ));
            }
            if !matches!(scope_separator.as_deref(), None | Some(" " | ",")) {
                return Err(provider_error(provider, "invalid OAuth scope separator"));
            }
            let mut names = HashSet::with_capacity(extra_authorize_params.len());
            for (name, value) in extra_authorize_params {
                validate_token(name, "authorization parameter", 128)?;
                validate_text(value, "authorization parameter value", 512)?;
                if !names.insert(name) {
                    return Err(provider_error(
                        provider,
                        format!("duplicate authorization parameter `{name}`"),
                    ));
                }
            }
        }
        AuthMethod::OpenRouterPkce {
            authorize_url,
            exchange_url,
        } => {
            validate_provider_url(provider, authorize_url, "authorize_url")?;
            validate_provider_url(provider, exchange_url, "exchange_url")?;
        }
        AuthMethod::ApiKey {
            header,
            value_prefix,
        } => {
            reqwest::header::HeaderName::from_bytes(header.as_bytes())
                .map_err(|_| provider_error(provider, "invalid API key header"))?;
            if value_prefix.len() > 128
                || value_prefix.contains('\r')
                || value_prefix.contains('\n')
            {
                return Err(provider_error(provider, "invalid API key value prefix"));
            }
        }
        AuthMethod::Configuration => {}
    }
    validate_configuration_fields(provider, provider.integration_configuration_fields())?;
    validate_configuration_fields(provider, provider.connection_configuration_fields())?;
    Ok(())
}

fn validate_configuration_fields(
    provider: &Provider,
    fields: &[ConfigurationFieldDef],
) -> Result<(), CatalogError> {
    if fields.len() > 64 {
        return Err(provider_error(provider, "too many configuration fields"));
    }
    let mut names = HashSet::with_capacity(fields.len());
    for field in fields {
        validate_token(&field.name, "configuration field", 64)?;
        if !names.insert(field.name.as_str()) {
            return Err(provider_error(
                provider,
                format!("duplicate configuration field `{}`", field.name),
            ));
        }
    }
    Ok(())
}

fn validate_scopes(provider: &Provider) -> Result<(), CatalogError> {
    if provider.scopes.len() > 128 {
        return Err(provider_error(provider, "too many scopes"));
    }
    let mut names = HashSet::with_capacity(provider.scopes.len());
    for scope in &provider.scopes {
        validate_text(&scope.name, "scope name", 256)?;
        validate_text(&scope.description, "scope description", 1_024)?;
        if scope.default && scope.sensitive {
            return Err(provider_error(
                provider,
                format!("sensitive scope `{}` cannot be a default", scope.name),
            ));
        }
        if !names.insert(scope.name.as_str()) {
            return Err(provider_error(
                provider,
                format!("duplicate scope `{}`", scope.name),
            ));
        }
    }
    Ok(())
}

fn validate_egress(provider: &Provider) -> Result<(), CatalogError> {
    if matches!(&provider.auth, AuthMethod::Configuration)
        && provider.egress.scheme == "none"
        && provider.egress.authorities.is_empty()
        && provider.egress.path_prefixes.is_empty()
    {
        return Ok(());
    }
    let allow_mock_http = provider.id == "mock";
    if provider.egress.scheme != "https" && !(allow_mock_http && provider.egress.scheme == "http") {
        return Err(provider_error(provider, "egress scheme must be https"));
    }
    if provider.egress.authorities.is_empty() || provider.egress.authorities.len() > 32 {
        return Err(provider_error(
            provider,
            "egress authorities are empty or too large",
        ));
    }
    let mut authorities = HashSet::with_capacity(provider.egress.authorities.len());
    for authority in &provider.egress.authorities {
        if authority.len() > 255
            || authority.contains('/')
            || authority.contains('@')
            || authority.contains('?')
            || authority.contains('#')
        {
            return Err(provider_error(provider, "invalid egress authority"));
        }
        let parsed = Url::parse(&format!("{}://{authority}/", provider.egress.scheme))
            .map_err(|_| provider_error(provider, "invalid egress authority"))?;
        if parsed.host_str().is_none() || !authorities.insert(authority) {
            return Err(provider_error(
                provider,
                "invalid or duplicate egress authority",
            ));
        }
    }
    if provider.egress.path_prefixes.len() > 64 {
        return Err(provider_error(provider, "too many egress path prefixes"));
    }
    for prefix in &provider.egress.path_prefixes {
        if prefix.len() > 1_024
            || !prefix.starts_with('/')
            || prefix.contains("..")
            || prefix.contains('?')
            || prefix.contains('#')
        {
            return Err(provider_error(provider, "invalid egress path prefix"));
        }
    }
    Ok(())
}

fn validate_provider_url(provider: &Provider, raw: &str, field: &str) -> Result<(), CatalogError> {
    let parsed =
        Url::parse(raw).map_err(|_| provider_error(provider, format!("invalid {field}")))?;
    let allowed = parsed.scheme() == "https"
        || (provider.id == "mock"
            && parsed.scheme() == "http"
            && matches!(parsed.host_str(), Some("127.0.0.1" | "localhost" | "::1")));
    if !allowed
        || parsed.host_str().is_none()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
    {
        return Err(provider_error(provider, format!("invalid {field}")));
    }
    Ok(())
}

fn validate_https_url(raw: &str, field: &str) -> Result<(), CatalogError> {
    let parsed = Url::parse(raw).map_err(|_| CatalogError::invalid(format!("invalid {field}")))?;
    if parsed.scheme() != "https"
        || parsed.host_str().is_none()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
    {
        return Err(CatalogError::invalid(format!("invalid {field}")));
    }
    Ok(())
}

fn validate_id(value: &str) -> Result<(), CatalogError> {
    if value.is_empty()
        || value.len() > 64
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
    {
        return Err(CatalogError::invalid(format!(
            "invalid provider id `{value}`"
        )));
    }
    Ok(())
}

fn validate_token(value: &str, field: &str, max: usize) -> Result<(), CatalogError> {
    if value.is_empty()
        || value.len() > max
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b':'))
    {
        return Err(CatalogError::invalid(format!("invalid {field}")));
    }
    Ok(())
}

fn validate_text(value: &str, field: &str, max: usize) -> Result<(), CatalogError> {
    if value.trim().is_empty() || value.len() > max || value.contains('\0') {
        return Err(CatalogError::invalid(format!("invalid {field}")));
    }
    Ok(())
}

fn validate_unique_values(
    values: &[String],
    field: &str,
    max_count: usize,
    max_len: usize,
) -> Result<(), CatalogError> {
    if values.is_empty() || values.len() > max_count {
        return Err(CatalogError::invalid(format!(
            "{field} list is empty or too large"
        )));
    }
    let mut seen = HashSet::with_capacity(values.len());
    for value in values {
        validate_token(value, field, max_len)?;
        if !seen.insert(value) {
            return Err(CatalogError::invalid(format!(
                "duplicate {field} `{value}`"
            )));
        }
    }
    Ok(())
}

fn provider_error(provider: &Provider, message: impl std::fmt::Display) -> CatalogError {
    CatalogError::invalid(format!("provider `{}`: {message}", provider.id))
}

#[cfg(test)]
#[path = "catalog_tests.rs"]
mod tests;
