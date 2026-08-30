//! Versioned provider catalog and strict loader (ADR 0032 §3).
//!
//! Provider behavior is data. The broker refuses to start when the embedded
//! catalog is empty or invalid, so a broken artifact cannot look like a valid
//! deployment with zero connectors.

use std::collections::HashSet;
use std::sync::LazyLock;

use opensesame_domain::EgressBinding;
use serde::{Deserialize, Serialize};
use thiserror::Error;
use url::Url;

const CATALOG_JSON: &str = include_str!("catalog.json");
pub const CATALOG_SCHEMA_VERSION: u32 = 1;

/// Loopback default for the bundled mock authorization server; overridden per
/// deployment by `OPENSESAME_PROVIDER_MOCK_AUTHORIZE_URL` / `_TOKEN_URL`.
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
    /// Certificate authorities and issuance surfaces (ADR 0061).
    Certificates,
    /// Org-defined connectors (MCP servers, `OpenAPI` backends, internal APIs).
    Custom,
}

impl Category {
    #[must_use]
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

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(deny_unknown_fields)]
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

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Provider {
    pub id: String,
    pub display_name: String,
    pub category: Category,
    pub docs_url: String,
    pub provenance_url: String,
    pub auth: AuthMethod,
    pub scopes: Vec<ScopeDef>,
    pub egress: EgressSpec,
    pub operations: Vec<String>,
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
    validate_unique_values(&provider.operations, "operation", 128, 128)?;
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
mod tests {
    use super::*;

    #[test]
    fn embedded_catalog_is_valid_and_versioned() {
        let catalog = load().expect("embedded catalog");
        assert_eq!(catalog.revision(), "2026-08-30.1");
        assert_eq!(catalog.providers().len(), 89);
        assert_eq!(
            catalog
                .providers()
                .iter()
                .filter(|provider| provider.id != "mock")
                .count(),
            88
        );
        assert_eq!(catalog.find("github").unwrap().display_name, "GitHub");
    }

    #[test]
    fn certificate_connections_are_capability_scoped() {
        let catalog = load().expect("embedded catalog");
        let letsencrypt = catalog.find("letsencrypt").expect("letsencrypt");
        assert!(matches!(letsencrypt.auth, AuthMethod::Configuration));
        assert_eq!(
            letsencrypt.egress.authorities,
            [
                "acme-v02.api.letsencrypt.org",
                "acme-staging-v02.api.letsencrypt.org"
            ]
        );

        let zerossl = catalog.find("zerossl").expect("zerossl");
        assert!(zerossl
            .connection_configuration_fields()
            .iter()
            .any(|field| field.name == "eab_hmac_key" && field.secret));

        let cloudflare = catalog.find("cloudflare").expect("cloudflare");
        assert!(cloudflare
            .operations
            .iter()
            .any(|operation| operation == "acme_dns_challenge.write"));
        assert!(!cloudflare
            .operations
            .iter()
            .any(|operation| operation == "certificate.origin.issue"));
        let origin = catalog
            .find("cloudflare-origin-ca")
            .expect("cloudflare origin CA");
        assert!(origin
            .operations
            .iter()
            .any(|operation| operation == "certificate.origin.issue"));
        assert_eq!(origin.egress.path_prefixes, ["/client/v4/certificates"]);
    }

    #[test]
    fn catalog_covers_every_fnox_provider_type() {
        let expected = [
            ("age", Category::Encryption),
            ("fido2", Category::Encryption),
            ("yubikey", Category::Encryption),
            ("aws-kms", Category::Encryption),
            ("azure-kms", Category::Encryption),
            ("gcp-kms", Category::Encryption),
            ("aws-ps", Category::CloudSecretStorage),
            ("aws", Category::CloudSecretStorage),
            ("azure-ac", Category::CloudSecretStorage),
            ("azure-sm", Category::CloudSecretStorage),
            ("gcp", Category::CloudSecretStorage),
            ("doppler", Category::CloudSecretStorage),
            ("foks", Category::CloudSecretStorage),
            ("bitwarden-sm", Category::CloudSecretStorage),
            ("vault", Category::CloudSecretStorage),
            ("openbao", Category::CloudSecretStorage),
            ("encrypted-remote", Category::CloudSecretStorage),
            ("1password", Category::PasswordManagers),
            ("bitwarden", Category::PasswordManagers),
            ("vaultwarden", Category::PasswordManagers),
            ("infisical", Category::PasswordManagers),
            ("proton-pass", Category::PasswordManagers),
            ("passwordstate", Category::PasswordManagers),
            ("keychain", Category::LocalStorage),
            ("keepass", Category::LocalStorage),
            ("password-store", Category::LocalStorage),
            ("sealed-local", Category::LocalStorage),
            ("plain", Category::LocalStorage),
        ];
        let catalog = load().expect("embedded catalog");
        for (id, category) in expected {
            let provider = catalog
                .find(id)
                .unwrap_or_else(|| panic!("missing Fnox provider {id}"));
            assert_eq!(provider.category, category, "wrong category for {id}");
            assert!(matches!(&provider.auth, AuthMethod::Configuration));
        }
    }

    /// Passbolt is not an fnox provider: it is a self-hosted, PGP-keyed
    /// password manager whose connection is configured, not OAuth'd. The row
    /// must survive the strict loader with its two secret fields intact, and
    /// must claim no egress — the server URL is user-supplied, so a static
    /// allowlist cannot enumerate it (see the client-side pinning rule).
    #[test]
    fn passbolt_round_trips_through_the_strict_loader() {
        let catalog = load().expect("embedded catalog");
        let passbolt = catalog.find("passbolt").expect("passbolt provider");
        assert_eq!(passbolt.category, Category::PasswordManagers);
        assert!(matches!(&passbolt.auth, AuthMethod::Configuration));
        let fields: Vec<(&str, bool, bool)> = passbolt
            .connection_configuration_fields()
            .iter()
            .map(|field| (field.name.as_str(), field.secret, field.required))
            .collect();
        assert_eq!(
            fields,
            vec![
                ("server_url", false, true),
                ("private_key", true, true),
                ("passphrase", true, true),
            ]
        );
        assert_eq!(passbolt.egress.scheme, "none");
        assert!(passbolt.egress.authorities.is_empty());
        assert!(passbolt.egress.path_prefixes.is_empty());
        assert!(passbolt.scopes.is_empty());
        assert_eq!(passbolt.operations, vec!["secret.configure".to_string()]);

        // The row survives a parse of the document it came from, so the
        // committed JSON is what the loader accepts, not a hand-built struct.
        let reparsed = Catalog::parse(CATALOG_JSON).expect("reparse");
        assert_eq!(reparsed.find("passbolt"), Some(passbolt));
    }

    #[test]
    fn catalog_includes_required_llm_providers() {
        let expected = [
            "anthropic",
            "openai",
            "azure-openai",
            "aws-bedrock",
            "openrouter",
            "huggingface",
        ];
        let catalog = load().expect("embedded catalog");
        for id in expected {
            assert!(catalog.find(id).is_some(), "missing LLM provider {id}");
        }
    }

    #[test]
    fn catalog_includes_required_identity_providers() {
        let catalog = load().expect("embedded catalog");
        for id in ["better-auth", "workos", "auth0"] {
            let provider = catalog
                .find(id)
                .unwrap_or_else(|| panic!("missing identity provider {id}"));
            assert_eq!(provider.category, Category::Identity);
        }
        assert!(matches!(
            &catalog.find("workos").unwrap().auth,
            AuthMethod::ApiKey { header, value_prefix }
                if header == "Authorization" && value_prefix == "Bearer "
        ));
        for id in ["better-auth", "auth0"] {
            assert!(matches!(
                &catalog.find(id).unwrap().auth,
                AuthMethod::Configuration
            ));
        }
    }

    #[test]
    fn empty_and_invalid_catalogs_fail_closed() {
        let empty = r#"{"schema_version":1,"revision":"test.1","providers":[]}"#;
        assert_eq!(
            Catalog::parse(empty).unwrap_err().to_string(),
            "catalog has no providers"
        );

        let mut invalid: serde_json::Value = serde_json::from_str(CATALOG_JSON).unwrap();
        invalid["providers"][0]["egress"]["authorities"] = serde_json::json!([]);
        assert!(Catalog::parse(&invalid.to_string())
            .unwrap_err()
            .to_string()
            .contains("egress authorities"));
    }

    #[test]
    fn duplicate_ids_and_unknown_fields_are_rejected() {
        let mut duplicate: serde_json::Value = serde_json::from_str(CATALOG_JSON).unwrap();
        duplicate["providers"][1]["id"] = duplicate["providers"][0]["id"].clone();
        assert!(Catalog::parse(&duplicate.to_string())
            .unwrap_err()
            .to_string()
            .contains("duplicate provider id"));

        let mut unknown: serde_json::Value = serde_json::from_str(CATALOG_JSON).unwrap();
        unknown["providers"][0]["secret"] = serde_json::json!("must not be accepted");
        assert!(Catalog::parse(&unknown.to_string())
            .unwrap_err()
            .to_string()
            .contains("unknown field"));
    }

    #[test]
    fn sensitive_scopes_cannot_be_defaults() {
        let mut invalid: serde_json::Value = serde_json::from_str(CATALOG_JSON).unwrap();
        invalid["providers"][0]["scopes"][1]["default"] = serde_json::json!(true);
        assert!(Catalog::parse(&invalid.to_string())
            .unwrap_err()
            .to_string()
            .contains("sensitive scope `repo` cannot be a default"));
    }
}
