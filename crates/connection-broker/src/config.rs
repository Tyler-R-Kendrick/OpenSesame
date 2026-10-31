//! Deployment configuration. A provider the deployment cannot actually use is
//! reported as unconfigured and names the variables it wants, rather than being
//! hidden or offered as a button that fails (ADR 0032 §8).

use std::collections::BTreeMap;
use std::{env, fs, path::PathBuf};

use crate::catalog::{self, AuthMethod, Provider};
use opensesame_connection_detect::{
    detected_file_value, env_aliases, is_aws_credential_field, is_aws_provider, non_empty,
};

pub const ENV_CONNECTION_KEY: &str = "OPENSESAME_CONNECTION_KEY";
pub const ENV_PUBLIC_URL: &str = "OPENSESAME_PUBLIC_URL";
pub const ENV_REDIRECT_ALLOWLIST: &str = "OPENSESAME_CONNECTION_REDIRECT_ALLOWLIST";
/// Points every STS mint at a loopback stand-in. Read only by a build with the
/// `sts-stand-in` feature (the tests' build, never a shipped one); the egress
/// rule for such an endpoint admits loopback hosts alone (ADR 0217).
#[cfg(feature = "sts-stand-in")]
pub const ENV_TEST_AWS_STS_ENDPOINT: &str = "OPENSESAME_TEST_AWS_STS_ENDPOINT";

const DEFAULT_PUBLIC_URL: &str = "http://127.0.0.1:8787";

/// Per-provider client credentials and endpoint overrides.
#[derive(Clone, Default)]
pub struct ProviderConfig {
    pub client_id: Option<String>,
    pub client_secret: Option<String>,
    pub authorize_url: Option<String>,
    pub token_url: Option<String>,
}

#[derive(Clone, Default)]
pub struct BrokerConfig {
    /// Absent means the broker refuses to store credentials at all. There is no
    /// derived or default key: a token sealed under a guessable key is not sealed.
    key: Option<[u8; 32]>,
    public_url: String,
    redirect_allowlist: Vec<String>,
    providers: BTreeMap<String, ProviderConfig>,
    detected_connections: BTreeMap<String, BTreeMap<String, String>>,
    /// Override for GitHub REST API (tests). Default `https://api.github.com`.
    github_api_base: Option<String>,
    /// Override for the STS endpoint (tests, loopback only; ADR 0217). Never
    /// read from the environment.
    aws_sts_endpoint: Option<String>,
}

impl std::fmt::Debug for BrokerConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("BrokerConfig")
            .field("key", &self.key.is_some())
            .field("public_url", &self.public_url)
            .field("redirect_allowlist", &self.redirect_allowlist)
            .field("providers", &self.providers.keys().collect::<Vec<_>>())
            .field(
                "detected_connections",
                &self.detected_connections.keys().collect::<Vec<_>>(),
            )
            .field("github_api_base", &self.github_api_base)
            .field("aws_sts_endpoint", &self.aws_sts_endpoint)
            .finish()
    }
}

#[must_use]
pub fn env_var_name(provider_id: &str, suffix: &str) -> String {
    format!(
        "OPENSESAME_PROVIDER_{}_{suffix}",
        provider_id.to_uppercase().replace('-', "_")
    )
}

impl BrokerConfig {
    /// # Errors
    ///
    /// Returns an error when the bundled provider catalog is invalid.
    pub fn from_env() -> crate::Result<Self> {
        let mut providers = BTreeMap::new();
        let mut detected_connections = BTreeMap::new();
        for provider in catalog::all()? {
            let cfg = ProviderConfig {
                client_id: non_empty(env::var(env_var_name(&provider.id, "CLIENT_ID")).ok()),
                client_secret: non_empty(
                    env::var(env_var_name(&provider.id, "CLIENT_SECRET")).ok(),
                ),
                authorize_url: non_empty(
                    env::var(env_var_name(&provider.id, "AUTHORIZE_URL")).ok(),
                ),
                token_url: non_empty(env::var(env_var_name(&provider.id, "TOKEN_URL")).ok()),
            };
            providers.insert(provider.id.to_string(), cfg);
            if let Some(configuration) = detect_connection_configuration(provider) {
                detected_connections.insert(provider.id.to_string(), configuration);
            }
        }

        let key = match env::var(ENV_CONNECTION_KEY).ok().filter(|v| !v.is_empty()) {
            Some(raw) => match decode_key(&raw) {
                Ok(k) => Some(k),
                Err(e) => {
                    tracing::error!(error = %e, "{ENV_CONNECTION_KEY} is unusable; credential storage disabled");
                    None
                }
            },
            None => None,
        };

        Ok(Self {
            key,
            public_url: env::var(ENV_PUBLIC_URL)
                .ok()
                .filter(|v| !v.is_empty())
                .unwrap_or_else(|| DEFAULT_PUBLIC_URL.to_string()),
            redirect_allowlist: env::var(ENV_REDIRECT_ALLOWLIST)
                .unwrap_or_default()
                .split(',')
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .collect(),
            providers,
            detected_connections,
            github_api_base: None,
            aws_sts_endpoint: test_sts_endpoint(),
        })
    }

    /// Configuration assembled in-process, for tests and embedders that do not
    /// want the ambient environment.
    pub fn in_memory(key: Option<[u8; 32]>, public_url: impl Into<String>) -> Self {
        Self {
            key,
            public_url: public_url.into(),
            redirect_allowlist: Vec::new(),
            providers: BTreeMap::new(),
            detected_connections: BTreeMap::new(),
            github_api_base: None,
            aws_sts_endpoint: None,
        }
    }

    #[must_use]
    pub fn with_github_api_base(mut self, base: impl Into<String>) -> Self {
        self.github_api_base = Some(base.into());
        self
    }

    /// Send every STS mint to a loopback stand-in instead of the regional
    /// endpoint. In-process only, like [`BrokerConfig::with_github_api_base`].
    #[must_use]
    pub fn with_aws_sts_endpoint(mut self, url: impl Into<String>) -> Self {
        self.aws_sts_endpoint = Some(url.into());
        self
    }

    #[must_use]
    pub fn aws_sts_endpoint(&self) -> Option<&str> {
        self.aws_sts_endpoint.as_deref()
    }

    #[must_use]
    pub fn github_api_base(&self) -> &str {
        self.github_api_base
            .as_deref()
            .unwrap_or("https://api.github.com")
            .trim_end_matches('/')
    }

    #[must_use]
    pub fn with_provider(mut self, id: &str, cfg: ProviderConfig) -> Self {
        self.providers.insert(id.to_string(), cfg);
        self
    }

    #[must_use]
    pub fn with_redirect_allowlist(mut self, origins: Vec<String>) -> Self {
        self.redirect_allowlist = origins;
        self
    }

    #[must_use]
    pub fn with_detected_connection(
        mut self,
        id: &str,
        configuration: BTreeMap<String, String>,
    ) -> Self {
        self.detected_connections
            .insert(id.to_string(), configuration);
        self
    }

    #[must_use]
    pub fn detected_connection(&self, id: &str) -> Option<BTreeMap<String, String>> {
        self.detected_connections.get(id).cloned()
    }

    #[must_use]
    pub fn key(&self) -> Option<&[u8; 32]> {
        self.key.as_ref()
    }

    #[must_use]
    pub fn public_url(&self) -> &str {
        self.public_url.trim_end_matches('/')
    }

    #[must_use]
    pub fn provider(&self, id: &str) -> ProviderConfig {
        self.providers.get(id).cloned().unwrap_or_default()
    }

    #[must_use]
    pub fn authorize_url(&self, provider: &Provider) -> Option<String> {
        let overridden = self.provider(&provider.id).authorize_url;
        match &provider.auth {
            AuthMethod::OAuth2AuthCode { authorize_url, .. } => {
                Some(overridden.unwrap_or_else(|| authorize_url.to_string()))
            }
            AuthMethod::OpenRouterPkce { authorize_url, .. } => {
                Some(overridden.unwrap_or_else(|| authorize_url.to_string()))
            }
            AuthMethod::ApiKey { .. } | AuthMethod::Configuration => None,
        }
    }

    #[must_use]
    pub fn token_url(&self, provider: &Provider) -> Option<String> {
        let overridden = self.provider(&provider.id).token_url;
        match &provider.auth {
            AuthMethod::OAuth2AuthCode { token_url, .. } => {
                Some(overridden.unwrap_or_else(|| token_url.to_string()))
            }
            AuthMethod::OpenRouterPkce { exchange_url, .. } => {
                Some(overridden.unwrap_or_else(|| exchange_url.to_string()))
            }
            AuthMethod::ApiKey { .. } | AuthMethod::Configuration => None,
        }
    }

    /// The callback this deployment publishes for a provider redirect.
    #[must_use]
    pub fn callback_url(&self, provider_id: &str) -> String {
        format!("{}/api/v1/oauth/callback/{provider_id}", self.public_url())
    }

    /// A redirect target is either our own callback or an explicitly allowlisted
    /// origin. An open redirect here would hand the authorization code away.
    /// Pages return URLs after GitHub App Manifest registration.
    #[must_use]
    pub fn return_to_allowed(&self, return_to: &str) -> bool {
        let Ok(url) = url::Url::parse(return_to) else {
            return false;
        };
        if !matches!(url.scheme(), "http" | "https") {
            return false;
        }
        let host = url.host_str().unwrap_or("");
        if matches!(host, "127.0.0.1" | "localhost" | "[::1]") {
            return true;
        }
        let origin = url.origin().ascii_serialization();
        self.redirect_allowlist
            .iter()
            .any(|allowed| allowed == return_to || allowed.trim_end_matches('/') == origin)
    }

    #[must_use]
    pub fn redirect_allowed(&self, provider_id: &str, redirect_uri: &str) -> bool {
        if redirect_uri == self.callback_url(provider_id) {
            return true;
        }
        // Loopback Hosts treat 127.0.0.1 and localhost as the same callback host.
        if let (Ok(expected), Ok(actual)) = (
            url::Url::parse(&self.callback_url(provider_id)),
            url::Url::parse(redirect_uri),
        ) {
            let loopback_pair = |a: Option<&str>, b: Option<&str>| {
                matches!(
                    (a, b),
                    (Some("127.0.0.1"), Some("localhost")) | (Some("localhost"), Some("127.0.0.1"))
                )
            };
            if expected.scheme() == actual.scheme()
                && expected.port_or_known_default() == actual.port_or_known_default()
                && expected.path() == actual.path()
                && loopback_pair(expected.host_str(), actual.host_str())
            {
                return true;
            }
        }
        let Ok(url) = url::Url::parse(redirect_uri) else {
            return false;
        };
        let origin = url.origin().ascii_serialization();
        self.redirect_allowlist
            .iter()
            .any(|allowed| allowed == redirect_uri || allowed.trim_end_matches('/') == origin)
    }

    #[must_use]
    pub fn configured(&self, provider: &Provider) -> bool {
        self.missing_config(provider).is_empty()
    }

    /// The exact environment variable names a deployment must set. Order is
    /// stable so the UI can render it without sorting.
    #[must_use]
    pub fn missing_config(&self, provider: &Provider) -> Vec<String> {
        let mut missing = Vec::new();
        if self.key.is_none() {
            missing.push(ENV_CONNECTION_KEY.to_string());
        }
        if provider.auth.requires_client_credentials() {
            let cfg = self.provider(&provider.id);
            if cfg.client_id.is_none() {
                missing.push(env_var_name(&provider.id, "CLIENT_ID"));
            }
            if cfg.client_secret.is_none() {
                missing.push(env_var_name(&provider.id, "CLIENT_SECRET"));
            }
        }
        missing
    }
}

fn detect_connection_configuration(provider: &Provider) -> Option<BTreeMap<String, String>> {
    detect_connection_configuration_with(
        provider,
        &|name| non_empty(env::var(name).ok()),
        &|path| {
            (fs::metadata(path).ok()?.len() <= crate::MAX_CREDENTIAL_BYTES as u64)
                .then(|| fs::read_to_string(path).ok())?
        },
    )
}

fn detect_connection_configuration_with(
    provider: &Provider,
    read_env: &impl Fn(&str) -> Option<String>,
    read_file: &impl Fn(&PathBuf) -> Option<String>,
) -> Option<BTreeMap<String, String>> {
    let mut configuration = BTreeMap::new();
    let aws_environment_credentials = is_aws_provider(&provider.id)
        && ["access_key_id", "secret_access_key"]
            .iter()
            .any(|field| connection_environment_value(provider, field, read_env).is_some());
    for field in provider.connection_configuration_fields() {
        let value = connection_environment_value(provider, &field.name, read_env).or_else(|| {
            (!aws_environment_credentials || !is_aws_credential_field(&field.name))
                .then(|| detected_file_value(&provider.id, &field.name, read_env, read_file))
                .flatten()
        });
        if let Some(value) = value
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty() && value.len() <= crate::MAX_CREDENTIAL_BYTES)
        {
            configuration.insert(field.name.clone(), value);
        }
    }

    if provider.id == "better-auth" {
        configuration
            .entry("api_key_header".into())
            .or_insert_with(|| "x-api-key".into());
        configuration
            .entry("config_id".into())
            .or_insert_with(|| "default".into());
    }
    if provider.id == "auth0" {
        if let Some(domain) = configuration.get_mut("domain") {
            *domain = domain
                .trim_start_matches("https://")
                .trim_start_matches("http://")
                .trim_end_matches('/')
                .to_string();
        }
        if let Some(domain) = configuration.get("domain").cloned() {
            configuration
                .entry("audience".into())
                .or_insert_with(|| format!("https://{domain}/api/v2/"));
        }
    }
    if matches!(provider.id.as_str(), "vault" | "openbao") && configuration.contains_key("token") {
        configuration
            .entry("address".into())
            .or_insert_with(|| "http://127.0.0.1:8200".into());
    }

    if provider.id == "github" {
        if let Some(token) = read_env("GITHUB_TOKEN")
            .or_else(|| read_env("GH_TOKEN"))
            .or_else(|| read_env(&env_var_name("github", "TOKEN")))
        {
            configuration.insert("access_token".into(), token);
        }
    }

    if provider.id == "github" && configuration.contains_key("access_token") {
        return Some(configuration);
    }

    provider
        .connection_configuration_fields()
        .iter()
        .filter(|field| field.required)
        .all(|field| configuration.contains_key(&field.name))
        .then_some(configuration)
        .filter(|configuration| !configuration.is_empty())
}

fn connection_environment_value(
    provider: &Provider,
    field: &str,
    read_env: &impl Fn(&str) -> Option<String>,
) -> Option<String> {
    let suffix = field.to_uppercase().replace('-', "_");
    let explicit = env_var_name(&provider.id, &suffix);
    let generic = (field == "api_key")
        .then(|| format!("{}_API_KEY", provider.id.to_uppercase().replace('-', "_")));
    read_env(&explicit)
        .or_else(|| generic.as_deref().and_then(read_env))
        .or_else(|| {
            env_aliases(&provider.id, field)
                .iter()
                .find_map(|name| read_env(name))
        })
}

/// The stand-in STS endpoint a test build was given, when it was given one.
#[cfg(feature = "sts-stand-in")]
fn test_sts_endpoint() -> Option<String> {
    non_empty(env::var(ENV_TEST_AWS_STS_ENDPOINT).ok())
}

/// A shipped build has no such knob: the endpoint is the region's.
#[cfg(not(feature = "sts-stand-in"))]
fn test_sts_endpoint() -> Option<String> {
    None
}

fn decode_key(raw: &str) -> anyhow::Result<[u8; 32]> {
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(raw.trim())
        .or_else(|_| base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(raw.trim()))?;
    if bytes.len() != 32 {
        anyhow::bail!("expected 32 bytes, got {}", bytes.len());
    }
    let mut key = [0u8; 32];
    key.copy_from_slice(&bytes);
    Ok(key)
}

#[cfg(test)]
#[path = "config_tests.rs"]
mod tests;
