//! Deployment configuration. A provider the deployment cannot actually use is
//! reported as unconfigured and names the variables it wants, rather than being
//! hidden or offered as a button that fails (ADR 0032 §8).

use std::collections::BTreeMap;
use std::{env, fs, path::PathBuf};

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
    detected_connections: BTreeMap<String, BTreeMap<String, String>>,
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

    pub fn with_detected_connection(
        mut self,
        id: &str,
        configuration: BTreeMap<String, String>,
    ) -> Self {
        self.detected_connections
            .insert(id.to_string(), configuration);
        self
    }

    pub fn detected_connection(&self, id: &str) -> Option<BTreeMap<String, String>> {
        self.detected_connections.get(id).cloned()
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
            connection_env_aliases(&provider.id, field)
                .iter()
                .find_map(|name| read_env(name))
        })
}

fn is_aws_provider(provider: &str) -> bool {
    matches!(provider, "aws" | "aws-kms" | "aws-ps" | "aws-bedrock")
}

fn is_aws_credential_field(field: &str) -> bool {
    matches!(
        field,
        "access_key_id" | "secret_access_key" | "session_token"
    )
}

fn detected_file_value(
    provider: &str,
    field: &str,
    read_env: &impl Fn(&str) -> Option<String>,
    read_file: &impl Fn(&PathBuf) -> Option<String>,
) -> Option<String> {
    let home = read_env("HOME").map(PathBuf::from);
    match (provider, field) {
        ("aws" | "aws-kms" | "aws-ps" | "aws-bedrock", field) => {
            detected_aws_file_value(field, read_env, read_file)
        }
        ("vault", "token") => home.and_then(|home| read_file(&home.join(".vault-token"))),
        ("openbao", "token") => home.and_then(|home| read_file(&home.join(".bao-token"))),
        ("gcp" | "gcp-kms", "service_account_json") => detected_gcp_file(read_env, read_file),
        ("gcp" | "gcp-kms", "project_id") => {
            let raw = detected_gcp_file(read_env, read_file)?;
            let parsed: serde_json::Value = serde_json::from_str(&raw).ok()?;
            parsed
                .get("project_id")
                .or_else(|| parsed.get("quota_project_id"))
                .and_then(serde_json::Value::as_str)
                .map(str::to_string)
        }
        _ => None,
    }
}

fn detected_gcp_file(
    read_env: &impl Fn(&str) -> Option<String>,
    read_file: &impl Fn(&PathBuf) -> Option<String>,
) -> Option<String> {
    let path = read_env("GOOGLE_APPLICATION_CREDENTIALS")
        .map(PathBuf::from)
        .or_else(|| {
            read_env("HOME").map(|home| {
                PathBuf::from(home).join(".config/gcloud/application_default_credentials.json")
            })
        })?;
    read_file(&path)
}

fn detected_aws_file_value(
    field: &str,
    read_env: &impl Fn(&str) -> Option<String>,
    read_file: &impl Fn(&PathBuf) -> Option<String>,
) -> Option<String> {
    let home = read_env("HOME").map(PathBuf::from);
    let profile = read_env("AWS_PROFILE").unwrap_or_else(|| "default".into());
    let credentials_path = read_env("AWS_SHARED_CREDENTIALS_FILE")
        .map(PathBuf::from)
        .or_else(|| home.as_ref().map(|home| home.join(".aws/credentials")));
    let config_path = read_env("AWS_CONFIG_FILE")
        .map(PathBuf::from)
        .or_else(|| home.map(|home| home.join(".aws/config")));
    let credentials = credentials_path.as_ref().and_then(read_file);
    let credential_key = match field {
        "access_key_id" => "aws_access_key_id",
        "secret_access_key" => "aws_secret_access_key",
        "session_token" => "aws_session_token",
        _ => "",
    };
    if !credential_key.is_empty() {
        return credentials
            .as_deref()
            .and_then(|contents| ini_value(contents, &profile, credential_key));
    }
    if field == "region" {
        let section = if profile == "default" {
            "default".to_string()
        } else {
            format!("profile {profile}")
        };
        return config_path
            .as_ref()
            .and_then(read_file)
            .as_deref()
            .and_then(|contents| ini_value(contents, &section, "region"));
    }
    None
}

fn ini_value(contents: &str, section: &str, key: &str) -> Option<String> {
    let mut current = "";
    for line in contents.lines().map(str::trim) {
        if let Some(name) = line
            .strip_prefix('[')
            .and_then(|line| line.strip_suffix(']'))
        {
            current = name.trim();
            continue;
        }
        if current != section || line.starts_with('#') || line.starts_with(';') {
            continue;
        }
        let Some((name, value)) = line.split_once('=') else {
            continue;
        };
        if name.trim() == key {
            return non_empty(Some(value.trim().to_string()));
        }
    }
    None
}

fn connection_env_aliases(provider: &str, field: &str) -> &'static [&'static str] {
    match (provider, field) {
        ("stripe", "api_key") => &["STRIPE_SECRET_KEY"],
        ("replicate", "api_key") => &["REPLICATE_API_TOKEN"],
        ("huggingface", "api_key") => &["HF_TOKEN", "HUGGING_FACE_HUB_TOKEN"],
        ("gemini", "api_key") => &["GOOGLE_API_KEY"],
        ("cloudflare", "api_key") => &["CLOUDFLARE_API_TOKEN"],
        ("vercel", "api_key") => &["VERCEL_TOKEN"],
        ("netlify", "api_key") => &["NETLIFY_AUTH_TOKEN"],
        ("postmark", "api_key") => &["POSTMARK_SERVER_TOKEN"],
        ("pagerduty", "api_key") => &["PAGERDUTY_API_TOKEN"],
        ("square", "api_key") => &["SQUARE_ACCESS_TOKEN"],
        ("ngrok", "api_key") => &["NGROK_AUTHTOKEN"],
        ("clerk", "api_key") => &["CLERK_SECRET_KEY"],
        ("launchdarkly", "api_key") => &["LAUNCHDARKLY_ACCESS_TOKEN"],
        ("circleci", "api_key") => &["CIRCLE_TOKEN"],
        ("buildkite", "api_key") => &["BUILDKITE_API_TOKEN"],
        ("digitalocean", "api_key") => &["DIGITALOCEAN_ACCESS_TOKEN"],
        ("railway", "api_key") => &["RAILWAY_TOKEN"],
        ("newsapi", "api_key") => &["NEWS_API_KEY"],
        ("better-auth", "base_url") => &["BETTER_AUTH_URL"],
        ("better-auth", "api_key") => &["BETTER_AUTH_API_KEY"],
        ("auth0", "domain") => &["AUTH0_DOMAIN"],
        ("auth0", "client_id") => &["AUTH0_CLIENT_ID"],
        ("auth0", "client_secret") => &["AUTH0_CLIENT_SECRET"],
        ("auth0", "audience") => &["AUTH0_AUDIENCE"],
        ("1password", "service_account_token") => &["OP_SERVICE_ACCOUNT_TOKEN"],
        ("bitwarden" | "vaultwarden", "session_token") => &["BW_SESSION"],
        ("doppler", "token") => &["DOPPLER_TOKEN"],
        ("infisical", "token") => &["INFISICAL_TOKEN"],
        ("password-store", "store_dir") => &["PASSWORD_STORE_DIR"],
        ("vault", "address") => &["VAULT_ADDR"],
        ("vault", "token") => &["VAULT_TOKEN"],
        ("openbao", "address") => &["BAO_ADDR"],
        ("openbao", "token") => &["BAO_TOKEN"],
        ("aws" | "aws-kms" | "aws-ps" | "aws-bedrock", "region") => {
            &["AWS_REGION", "AWS_DEFAULT_REGION"]
        }
        ("aws" | "aws-kms" | "aws-ps" | "aws-bedrock", "access_key_id") => &["AWS_ACCESS_KEY_ID"],
        ("aws" | "aws-kms" | "aws-ps" | "aws-bedrock", "secret_access_key") => {
            &["AWS_SECRET_ACCESS_KEY"]
        }
        ("aws" | "aws-kms" | "aws-ps" | "aws-bedrock", "session_token") => &["AWS_SESSION_TOKEN"],
        ("aws-kms", "key_id") => &["AWS_KMS_KEY_ID"],
        ("azure-sm" | "azure-kms" | "azure-ac", "tenant_id") => &["AZURE_TENANT_ID"],
        ("azure-sm" | "azure-kms" | "azure-ac", "client_id") => &["AZURE_CLIENT_ID"],
        ("azure-sm" | "azure-kms" | "azure-ac", "client_secret") => &["AZURE_CLIENT_SECRET"],
        ("azure-sm" | "azure-kms", "vault_url") => &["AZURE_KEY_VAULT_URL"],
        ("azure-kms", "key_name") => &["AZURE_KEY_VAULT_KEY_NAME"],
        ("azure-ac", "endpoint") => &["AZURE_APP_CONFIGURATION_ENDPOINT"],
        ("azure-openai", "endpoint") => &["AZURE_OPENAI_ENDPOINT"],
        ("azure-openai", "deployment") => &["AZURE_OPENAI_DEPLOYMENT"],
        ("azure-openai", "api_version") => &["AZURE_OPENAI_API_VERSION"],
        ("azure-openai", "api_key") => &["AZURE_OPENAI_API_KEY"],
        ("gcp" | "gcp-kms", "project_id") => &["GOOGLE_CLOUD_PROJECT", "GCLOUD_PROJECT"],
        ("gcp-kms", "location") => &["GOOGLE_KMS_LOCATION"],
        ("gcp-kms", "key_ring") => &["GOOGLE_KMS_KEY_RING"],
        ("gcp-kms", "key_name") => &["GOOGLE_KMS_KEY_NAME"],
        _ => &[],
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
    fn common_environment_names_and_safe_defaults_are_detected() {
        let values = BTreeMap::from([
            ("BETTER_AUTH_URL", "https://identity.example/api/auth"),
            ("BETTER_AUTH_API_KEY", "better-secret"),
            ("WORKOS_API_KEY", "workos-secret"),
            ("AUTH0_DOMAIN", "https://tenant.us.auth0.com/"),
            ("AUTH0_CLIENT_ID", "client"),
            ("AUTH0_CLIENT_SECRET", "auth0-secret"),
        ]);
        let read_env = |name: &str| values.get(name).map(|value| value.to_string());
        let read_file = |_path: &PathBuf| None;
        let better_auth = catalog::find("better-auth").unwrap().unwrap();
        assert_eq!(
            detect_connection_configuration_with(better_auth, &read_env, &read_file).unwrap(),
            BTreeMap::from([
                (
                    "base_url".into(),
                    "https://identity.example/api/auth".into()
                ),
                ("api_key".into(), "better-secret".into()),
                ("api_key_header".into(), "x-api-key".into()),
                ("config_id".into(), "default".into()),
            ])
        );
        let workos = catalog::find("workos").unwrap().unwrap();
        assert_eq!(
            detect_connection_configuration_with(workos, &read_env, &read_file).unwrap(),
            BTreeMap::from([("api_key".into(), "workos-secret".into())])
        );
        let auth0 = catalog::find("auth0").unwrap().unwrap();
        assert_eq!(
            detect_connection_configuration_with(auth0, &read_env, &read_file).unwrap(),
            BTreeMap::from([
                ("domain".into(), "tenant.us.auth0.com".into()),
                ("client_id".into(), "client".into()),
                ("client_secret".into(), "auth0-secret".into()),
                (
                    "audience".into(),
                    "https://tenant.us.auth0.com/api/v2/".into()
                ),
            ])
        );
    }

    #[test]
    fn host_files_are_detected_without_exposing_partial_configuration() {
        let values = BTreeMap::from([("HOME", "/host-user")]);
        let read_env = |name: &str| values.get(name).map(|value| value.to_string());
        let read_file = |path: &PathBuf| {
            (path == &PathBuf::from("/host-user/.vault-token")).then(|| "vault-secret\n".into())
        };
        let vault = catalog::find("vault").unwrap().unwrap();
        assert_eq!(
            detect_connection_configuration_with(vault, &read_env, &read_file).unwrap(),
            BTreeMap::from([
                ("address".into(), "http://127.0.0.1:8200".into()),
                ("token".into(), "vault-secret".into()),
            ])
        );

        let no_files = |_path: &PathBuf| None;
        assert!(detect_connection_configuration_with(vault, &read_env, &no_files).is_none());
    }

    #[test]
    fn the_selected_aws_profile_is_detected_from_standard_files() {
        let values = BTreeMap::from([("HOME", "/host-user"), ("AWS_PROFILE", "work")]);
        let read_env = |name: &str| values.get(name).map(|value| value.to_string());
        let read_file = |path: &PathBuf| {
            match path.to_string_lossy().as_ref() {
            "/host-user/.aws/credentials" => Some(
                "[work]\naws_access_key_id = detected-id\naws_secret_access_key = detected-secret\n"
                    .into(),
            ),
            "/host-user/.aws/config" => Some("[profile work]\nregion = us-west-2\n".into()),
            _ => None,
        }
        };
        let aws = catalog::find("aws").unwrap().unwrap();
        assert_eq!(
            detect_connection_configuration_with(aws, &read_env, &read_file).unwrap(),
            BTreeMap::from([
                ("region".into(), "us-west-2".into()),
                ("access_key_id".into(), "detected-id".into()),
                ("secret_access_key".into(), "detected-secret".into()),
            ])
        );
    }

    #[test]
    fn aws_key_pairs_never_mix_environment_and_profile_values() {
        let file = |path: &PathBuf| {
            (path == &PathBuf::from("/host-user/.aws/credentials")).then(|| {
                "[default]\naws_access_key_id = file-id\naws_secret_access_key = file-secret\n"
                    .into()
            })
        };
        let aws = catalog::find("aws").unwrap().unwrap();
        let partial = BTreeMap::from([
            ("HOME", "/host-user"),
            ("AWS_REGION", "us-east-1"),
            ("AWS_ACCESS_KEY_ID", "environment-id"),
        ]);
        assert!(detect_connection_configuration_with(
            aws,
            &|name| partial.get(name).map(|value| value.to_string()),
            &file,
        )
        .is_none());

        let complete = BTreeMap::from([
            ("HOME", "/host-user"),
            ("AWS_REGION", "us-east-1"),
            ("AWS_ACCESS_KEY_ID", "environment-id"),
            ("AWS_SECRET_ACCESS_KEY", "environment-secret"),
        ]);
        let detected = detect_connection_configuration_with(
            aws,
            &|name| complete.get(name).map(|value| value.to_string()),
            &file,
        )
        .unwrap();
        assert_eq!(detected["access_key_id"], "environment-id");
        assert_eq!(detected["secret_access_key"], "environment-secret");
    }

    #[test]
    fn gcp_application_credentials_supply_the_project_and_sealed_json() {
        let values = BTreeMap::from([("GOOGLE_APPLICATION_CREDENTIALS", "/credentials/gcp.json")]);
        let read_env = |name: &str| values.get(name).map(|value| value.to_string());
        let read_file = |path: &PathBuf| {
            (path == &PathBuf::from("/credentials/gcp.json"))
                .then(|| r#"{"type":"service_account","project_id":"demo-project"}"#.into())
        };
        let gcp = catalog::find("gcp").unwrap().unwrap();
        let detected = detect_connection_configuration_with(gcp, &read_env, &read_file).unwrap();
        assert_eq!(detected["project_id"], "demo-project");
        assert!(detected["service_account_json"].contains("service_account"));
    }

    #[test]
    fn a_key_of_the_wrong_length_is_refused() {
        assert!(decode_key("c2hvcnQ=").is_err());
        let ok = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, [1u8; 32]);
        assert_eq!(decode_key(&ok).unwrap(), [1u8; 32]);
    }
}
