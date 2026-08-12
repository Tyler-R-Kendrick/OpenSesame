//! Deployment configuration. A provider the deployment cannot actually use is
//! reported as unconfigured and names the variables it wants, rather than being
//! hidden or offered as a button that fails (ADR 0032 §8).

use std::collections::BTreeMap;
use std::env;

use crate::catalog::{self, AuthMethod, Provider};

pub const ENV_CONNECTION_KEY: &str = "OPENSESAME_CONNECTION_KEY";
pub const ENV_PUBLIC_URL: &str = "OPENSESAME_PUBLIC_URL";
pub const ENV_REDIRECT_ALLOWLIST: &str = "OPENSESAME_CONNECTION_REDIRECT_ALLOWLIST";

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
}

impl std::fmt::Debug for BrokerConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("BrokerConfig")
            .field("key", &self.key.is_some())
            .field("public_url", &self.public_url)
            .field("redirect_allowlist", &self.redirect_allowlist)
            .field("providers", &self.providers.keys().collect::<Vec<_>>())
            .finish()
    }
}

pub fn env_var_name(provider_id: &str, suffix: &str) -> String {
    format!(
        "OPENSESAME_PROVIDER_{}_{suffix}",
        provider_id.to_uppercase().replace('-', "_")
    )
}

impl BrokerConfig {
    pub fn from_env() -> crate::Result<Self> {
        let mut providers = BTreeMap::new();
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
        }
    }

    pub fn with_provider(mut self, id: &str, cfg: ProviderConfig) -> Self {
        self.providers.insert(id.to_string(), cfg);
        self
    }

    pub fn with_redirect_allowlist(mut self, origins: Vec<String>) -> Self {
        self.redirect_allowlist = origins;
        self
    }

    pub fn key(&self) -> Option<&[u8; 32]> {
        self.key.as_ref()
    }

    pub fn public_url(&self) -> &str {
        self.public_url.trim_end_matches('/')
    }

    pub fn provider(&self, id: &str) -> ProviderConfig {
        self.providers.get(id).cloned().unwrap_or_default()
    }

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
    pub fn callback_url(&self, provider_id: &str) -> String {
        format!("{}/api/v1/oauth/callback/{provider_id}", self.public_url())
    }

    /// A redirect target is either our own callback or an explicitly allowlisted
    /// origin. An open redirect here would hand the authorization code away.
    pub fn redirect_allowed(&self, provider_id: &str, redirect_uri: &str) -> bool {
        if redirect_uri == self.callback_url(provider_id) {
            return true;
        }
        let Ok(url) = url::Url::parse(redirect_uri) else {
            return false;
        };
        let origin = url.origin().ascii_serialization();
        self.redirect_allowlist
            .iter()
            .any(|allowed| allowed == redirect_uri || allowed.trim_end_matches('/') == origin)
    }

    pub fn configured(&self, provider: &Provider) -> bool {
        self.missing_config(provider).is_empty()
    }

    /// The exact environment variable names a deployment must set. Order is
    /// stable so the UI can render it without sorting.
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

fn non_empty(v: Option<String>) -> Option<String> {
    v.filter(|s| !s.is_empty())
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
mod tests {
    use super::*;
    use crate::catalog;

    fn key() -> [u8; 32] {
        [7u8; 32]
    }

    #[test]
    fn env_var_names_follow_the_provider_id() {
        assert_eq!(
            env_var_name("github", "CLIENT_ID"),
            "OPENSESAME_PROVIDER_GITHUB_CLIENT_ID"
        );
        assert_eq!(
            env_var_name("mock-idp", "TOKEN_URL"),
            "OPENSESAME_PROVIDER_MOCK_IDP_TOKEN_URL"
        );
    }

    #[test]
    fn no_key_means_nothing_is_configured() {
        let cfg = BrokerConfig::in_memory(None, "http://127.0.0.1:8787");
        for p in catalog::all().expect("catalog") {
            assert!(!cfg.configured(p), "{} claimed configured", p.id);
            assert!(
                cfg.missing_config(p)
                    .contains(&ENV_CONNECTION_KEY.to_string()),
                "{} did not name the key variable",
                p.id
            );
        }
    }

    /// Whatever is reported missing must be a variable a deployment can actually set.
    #[test]
    fn missing_config_names_real_variables() {
        let cfg = BrokerConfig::in_memory(Some(key()), "http://127.0.0.1:8787");
        for p in catalog::all().expect("catalog") {
            let missing = cfg.missing_config(p);
            if p.auth.requires_client_credentials() {
                assert_eq!(
                    missing,
                    vec![
                        env_var_name(&p.id, "CLIENT_ID"),
                        env_var_name(&p.id, "CLIENT_SECRET")
                    ],
                    "{}",
                    p.id
                );
            } else {
                assert!(missing.is_empty(), "{} wants {missing:?}", p.id);
            }
            for name in missing {
                assert!(name.starts_with("OPENSESAME_"), "{name}");
                assert!(!name.contains('-'), "{name}");
            }
        }
    }

    #[test]
    fn a_configured_oauth_provider_reports_clean() {
        let cfg = BrokerConfig::in_memory(Some(key()), "http://127.0.0.1:8787").with_provider(
            "github",
            ProviderConfig {
                client_id: Some("id".into()),
                client_secret: Some("secret".into()),
                ..Default::default()
            },
        );
        let github = catalog::find("github").expect("catalog").expect("github");
        assert!(cfg.configured(github));
        assert!(cfg.missing_config(github).is_empty());
    }

    #[test]
    fn only_our_callback_and_allowlisted_origins_are_redirect_targets() {
        let cfg = BrokerConfig::in_memory(Some(key()), "http://127.0.0.1:8787/")
            .with_redirect_allowlist(vec!["https://app.example".into()]);
        assert!(cfg.redirect_allowed(
            "github",
            "http://127.0.0.1:8787/api/v1/oauth/callback/github"
        ));
        assert!(cfg.redirect_allowed("github", "https://app.example/done"));
        assert!(!cfg.redirect_allowed("github", "https://evil.example/steal"));
        assert!(!cfg.redirect_allowed("github", "not a url"));
    }

    #[test]
    fn endpoint_overrides_win_over_the_catalog() {
        let mock = catalog::find("mock").expect("catalog").expect("mock");
        let cfg = BrokerConfig::in_memory(Some(key()), "http://127.0.0.1:8787").with_provider(
            "mock",
            ProviderConfig {
                token_url: Some("http://127.0.0.1:1/token".into()),
                ..Default::default()
            },
        );
        assert_eq!(
            cfg.token_url(mock).as_deref(),
            Some("http://127.0.0.1:1/token")
        );
        assert_eq!(
            cfg.authorize_url(mock).as_deref(),
            Some(catalog::MOCK_AUTHORIZE_URL)
        );
        let stripe = catalog::find("stripe").expect("catalog").expect("stripe");
        assert!(cfg.token_url(stripe).is_none());
    }

    #[test]
    fn a_key_of_the_wrong_length_is_refused() {
        assert!(decode_key("c2hvcnQ=").is_err());
        let ok = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, [1u8; 32]);
        assert_eq!(decode_key(&ok).unwrap(), [1u8; 32]);
    }
}
