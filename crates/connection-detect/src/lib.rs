//! Value-blind detection of provider credentials already configured on a host.
//!
//! Two callers share this: the Host broker, which turns a detection into a
//! sealed connection, and the local daemon, which only ever *reports* that
//! something looks configured (ADR 0047). Nothing here opens a network
//! connection, touches a database, or seals a credential — that machinery
//! lives in `opensesame-connection-broker` and deliberately does not follow
//! this code onto a loopback agent.
//!
//! Environment and filesystem access is injected by the caller, so a scan can
//! be run against a real process environment, another process's environment,
//! or a fixture without changing this code.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::PathBuf;

/// One (provider, field) pair and the environment variables that conventionally
/// carry it. Alternations in the original lookup are written out one entry per
/// provider so the table can be walked as well as queried.
pub struct AliasEntry {
    pub provider_id: &'static str,
    pub field: &'static str,
    pub env_names: &'static [&'static str],
}

const AWS_IDS: [&str; 4] = ["aws", "aws-kms", "aws-ps", "aws-bedrock"];

/// Providers whose credential is conventionally `{PROVIDER}_API_KEY`. The
/// generic form is probed for these in addition to the explicit table.
pub const GENERIC_API_KEY_PROVIDERS: &[&str] = &[
    "openai",
    "anthropic",
    "cohere",
    "mistral",
    "groq",
    "perplexity",
    "together",
    "fireworks",
    "elevenlabs",
    "stability",
    "deepgram",
    "assemblyai",
    "openrouter",
    "sendgrid",
    "resend",
    "brevo",
    "finnhub",
    "honeycomb",
];

macro_rules! aliases {
    ($(($provider:expr, $field:expr) => $names:expr),* $(,)?) => {
        &[$(AliasEntry { provider_id: $provider, field: $field, env_names: $names }),*]
    };
}

/// Curated environment-variable names per (provider, field).
pub const ALIASES: &[AliasEntry] = aliases![
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
    ("bitwarden", "session_token") => &["BW_SESSION"],
    ("vaultwarden", "session_token") => &["BW_SESSION"],
    ("doppler", "token") => &["DOPPLER_TOKEN"],
    ("infisical", "token") => &["INFISICAL_TOKEN"],
    ("password-store", "store_dir") => &["PASSWORD_STORE_DIR"],
    // Passbolt's server is self-hosted, so the base URL is the one field a host
    // conventionally already carries. The key and its passphrase have no
    // convention and deliberately get none here: naming an environment variable
    // for them would invite putting them there.
    ("passbolt", "server_url") => &["PASSBOLT_SERVER_URL"],
    ("vault", "address") => &["VAULT_ADDR"],
    ("vault", "token") => &["VAULT_TOKEN"],
    ("openbao", "address") => &["BAO_ADDR"],
    ("openbao", "token") => &["BAO_TOKEN"],
    ("aws", "region") => &["AWS_REGION", "AWS_DEFAULT_REGION"],
    ("aws-kms", "region") => &["AWS_REGION", "AWS_DEFAULT_REGION"],
    ("aws-ps", "region") => &["AWS_REGION", "AWS_DEFAULT_REGION"],
    ("aws-bedrock", "region") => &["AWS_REGION", "AWS_DEFAULT_REGION"],
    ("aws", "access_key_id") => &["AWS_ACCESS_KEY_ID"],
    ("aws-kms", "access_key_id") => &["AWS_ACCESS_KEY_ID"],
    ("aws-ps", "access_key_id") => &["AWS_ACCESS_KEY_ID"],
    ("aws-bedrock", "access_key_id") => &["AWS_ACCESS_KEY_ID"],
    ("aws", "secret_access_key") => &["AWS_SECRET_ACCESS_KEY"],
    ("aws-kms", "secret_access_key") => &["AWS_SECRET_ACCESS_KEY"],
    ("aws-ps", "secret_access_key") => &["AWS_SECRET_ACCESS_KEY"],
    ("aws-bedrock", "secret_access_key") => &["AWS_SECRET_ACCESS_KEY"],
    ("aws", "session_token") => &["AWS_SESSION_TOKEN"],
    ("aws-kms", "session_token") => &["AWS_SESSION_TOKEN"],
    ("aws-ps", "session_token") => &["AWS_SESSION_TOKEN"],
    ("aws-bedrock", "session_token") => &["AWS_SESSION_TOKEN"],
    ("aws-kms", "key_id") => &["AWS_KMS_KEY_ID"],
    ("azure-sm", "tenant_id") => &["AZURE_TENANT_ID"],
    ("azure-kms", "tenant_id") => &["AZURE_TENANT_ID"],
    ("azure-ac", "tenant_id") => &["AZURE_TENANT_ID"],
    ("azure-sm", "client_id") => &["AZURE_CLIENT_ID"],
    ("azure-kms", "client_id") => &["AZURE_CLIENT_ID"],
    ("azure-ac", "client_id") => &["AZURE_CLIENT_ID"],
    ("azure-sm", "client_secret") => &["AZURE_CLIENT_SECRET"],
    ("azure-kms", "client_secret") => &["AZURE_CLIENT_SECRET"],
    ("azure-ac", "client_secret") => &["AZURE_CLIENT_SECRET"],
    ("azure-sm", "vault_url") => &["AZURE_KEY_VAULT_URL"],
    ("azure-kms", "vault_url") => &["AZURE_KEY_VAULT_URL"],
    ("azure-kms", "key_name") => &["AZURE_KEY_VAULT_KEY_NAME"],
    ("azure-ac", "endpoint") => &["AZURE_APP_CONFIGURATION_ENDPOINT"],
    ("azure-openai", "endpoint") => &["AZURE_OPENAI_ENDPOINT"],
    ("azure-openai", "deployment") => &["AZURE_OPENAI_DEPLOYMENT"],
    ("azure-openai", "api_version") => &["AZURE_OPENAI_API_VERSION"],
    ("azure-openai", "api_key") => &["AZURE_OPENAI_API_KEY"],
    ("gcp", "project_id") => &["GOOGLE_CLOUD_PROJECT", "GCLOUD_PROJECT"],
    ("gcp-kms", "project_id") => &["GOOGLE_CLOUD_PROJECT", "GCLOUD_PROJECT"],
    ("gcp-kms", "location") => &["GOOGLE_KMS_LOCATION"],
    ("gcp-kms", "key_ring") => &["GOOGLE_KMS_KEY_RING"],
    ("gcp-kms", "key_name") => &["GOOGLE_KMS_KEY_NAME"],
];

/// Environment variables that conventionally carry this provider's field.
/// Empty when the field has no convention beyond the explicit form.
pub fn env_aliases(provider: &str, field: &str) -> &'static [&'static str] {
    ALIASES
        .iter()
        .find(|entry| entry.provider_id == provider && entry.field == field)
        .map(|entry| entry.env_names)
        .unwrap_or(&[])
}

/// The explicit, deployment-controlled variable for a provider field.
pub fn env_var_name(provider_id: &str, suffix: &str) -> String {
    format!(
        "OPENSESAME_PROVIDER_{}_{suffix}",
        provider_id.to_uppercase().replace('-', "_")
    )
}

pub fn is_aws_provider(provider: &str) -> bool {
    AWS_IDS.contains(&provider)
}

pub fn is_aws_credential_field(field: &str) -> bool {
    matches!(
        field,
        "access_key_id" | "secret_access_key" | "session_token"
    )
}

pub fn non_empty(v: Option<String>) -> Option<String> {
    v.filter(|s| !s.is_empty())
}

/// Provider credentials that live in a well-known file rather than the
/// environment.
pub fn detected_file_value(
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

pub fn detected_gcp_file(
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

pub fn detected_aws_file_value(
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

pub fn ini_value(contents: &str, section: &str, key: &str) -> Option<String> {
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

// ——— Value-blind host scan (ADR 0047) ————————————————————————————

/// Where a detection came from. The name is a variable or path, never a value.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SourceKind {
    Env,
    File,
    Mcp,
}

/// One place a provider's credential appears to be configured.
///
/// `name` is the environment variable, file path, or MCP server that matched.
/// There is deliberately no value, no prefix, and no length: a prefix narrows
/// an offline guess, and "it starts with `sk_live_`" is itself a disclosure.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Source {
    pub kind: SourceKind,
    pub name: String,
}

/// A provider that looks configured on this host.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Detection {
    pub provider_id: String,
    pub sources: Vec<Source>,
}

/// Report which providers look configured, naming only where each was seen.
///
/// Detection is best effort in both directions: an environment variable named
/// like a provider's may hold something else, and a credential kept in a
/// keychain or a shell function is invisible here. Callers phrase the result
/// as "these look configured", never "these are connected".
pub fn scan(
    read_env: &impl Fn(&str) -> Option<String>,
    read_file: &impl Fn(&PathBuf) -> Option<String>,
) -> Vec<Detection> {
    let mut found: BTreeMap<String, Vec<Source>> = BTreeMap::new();
    let mut note = |provider: &str, kind: SourceKind, name: String| {
        let sources: &mut Vec<Source> = found.entry(provider.to_string()).or_default();
        let source = Source { kind, name };
        if !sources.contains(&source) {
            sources.push(source);
        }
    };

    for entry in ALIASES {
        for name in entry.env_names {
            if read_env(name).is_some() {
                note(entry.provider_id, SourceKind::Env, (*name).to_string());
            }
        }
        let explicit = env_var_name(
            entry.provider_id,
            &entry.field.to_uppercase().replace('-', "_"),
        );
        if read_env(&explicit).is_some() {
            note(entry.provider_id, SourceKind::Env, explicit);
        }
    }

    for provider in GENERIC_API_KEY_PROVIDERS {
        let generic = format!("{}_API_KEY", provider.to_uppercase().replace('-', "_"));
        if read_env(&generic).is_some() {
            note(provider, SourceKind::Env, generic);
        }
    }

    // GitHub is the one provider whose bearer is read from the ecosystem's own
    // variables rather than a configuration field.
    for name in ["GITHUB_TOKEN", "GH_TOKEN"] {
        if read_env(name).is_some() {
            note("github", SourceKind::Env, name.to_string());
        }
    }

    for (provider, field, label) in [
        ("vault", "token", "~/.vault-token"),
        ("openbao", "token", "~/.bao-token"),
        ("aws", "access_key_id", "~/.aws/credentials"),
        (
            "gcp",
            "project_id",
            "gcloud application default credentials",
        ),
    ] {
        if detected_file_value(provider, field, read_env, read_file).is_some() {
            note(provider, SourceKind::File, label.to_string());
        }
    }

    found
        .into_iter()
        .map(|(provider_id, sources)| Detection {
            provider_id,
            sources,
        })
        .collect()
}

/// MCP server names declared in a client configuration file.
///
/// These files routinely hold raw API keys inside each server's `env` block,
/// so only the server name and the *names* of its environment keys are read.
/// No value from this file is returned, stored, or logged.
pub fn mcp_server_names(contents: &str) -> Vec<String> {
    let Ok(parsed) = serde_json::from_str::<serde_json::Value>(contents) else {
        return Vec::new();
    };
    let Some(servers) = parsed.get("mcpServers").and_then(|v| v.as_object()) else {
        return Vec::new();
    };
    servers.keys().cloned().collect()
}

// ——— Capability-moded offers (ADR 0047, offer schema v1) ———————————

mod offers;
pub use offers::*;

mod promote;
pub use promote::{PromoteRequest, PromotionMode};

#[cfg(test)]
mod tests {
    use super::*;

    fn env_from(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> + use<> {
        let owned: Vec<(String, String)> = pairs
            .iter()
            .map(|(k, v)| ((*k).to_string(), (*v).to_string()))
            .collect();
        move |name: &str| {
            owned
                .iter()
                .find(|(k, _)| k == name)
                .map(|(_, v)| v.clone())
        }
    }

    fn no_files() -> impl Fn(&PathBuf) -> Option<String> {
        |_: &PathBuf| None
    }

    #[test]
    fn property_alias_lookup_matches_the_table() {
        for entry in ALIASES {
            assert_eq!(
                env_aliases(entry.provider_id, entry.field),
                entry.env_names,
                "{}/{}",
                entry.provider_id,
                entry.field
            );
        }
        assert!(env_aliases("stripe", "not_a_field").is_empty());
        assert!(env_aliases("not-a-provider", "api_key").is_empty());
    }

    #[test]
    fn property_aws_alternations_all_resolve() {
        for provider in AWS_IDS {
            assert_eq!(
                env_aliases(provider, "access_key_id"),
                &["AWS_ACCESS_KEY_ID"]
            );
            assert_eq!(
                env_aliases(provider, "region"),
                &["AWS_REGION", "AWS_DEFAULT_REGION"]
            );
        }
        assert_eq!(env_aliases("bitwarden", "session_token"), &["BW_SESSION"]);
        assert_eq!(env_aliases("vaultwarden", "session_token"), &["BW_SESSION"]);
        assert_eq!(
            env_aliases("passbolt", "server_url"),
            &["PASSBOLT_SERVER_URL"]
        );
        // The private key and its passphrase have no alias by design: a
        // detector that named one would be telling people to export it.
        assert!(env_aliases("passbolt", "private_key").is_empty());
        assert!(env_aliases("passbolt", "passphrase").is_empty());
    }

    #[test]
    fn adversarial_scan_reports_names_and_never_values() {
        let secret = "PLANTED-STRIPE-VALUE-MUST-NOT-ESCAPE";
        let token = "PLANTED-GITHUB-VALUE-MUST-NOT-ESCAPE";
        let env = env_from(&[
            ("STRIPE_SECRET_KEY", secret),
            ("GITHUB_TOKEN", token),
            ("OPENAI_API_KEY", "PLANTED-OPENAI-VALUE-MUST-NOT-ESCAPE"),
        ]);
        let found = scan(&env, &no_files());
        let rendered = serde_json::to_string(&found).expect("serializable");

        assert!(rendered.contains("stripe") && rendered.contains("STRIPE_SECRET_KEY"));
        assert!(rendered.contains("github") && rendered.contains("GITHUB_TOKEN"));
        assert!(rendered.contains("openai"));
        // The whole point of the contract: a planted value never comes back.
        assert!(!rendered.contains(secret));
        assert!(!rendered.contains(token));
        assert!(!rendered.contains("PLANTED-OPENAI-VALUE-MUST-NOT-ESCAPE"));
    }

    #[test]
    fn contract_absent_credentials_are_not_reported() {
        let found = scan(&env_from(&[("PATH", "/usr/bin")]), &no_files());
        assert!(found.is_empty());
    }

    #[test]
    fn adversarial_mcp_config_yields_names_only() {
        let contents = r#"{
          "mcpServers": {
            "github": { "command": "npx", "env": { "GITHUB_TOKEN": "PLANTED-MCP-ENV-VALUE-MUST-NOT-ESCAPE" } },
            "local": { "command": "./server" }
          }
        }"#;
        let names = mcp_server_names(contents);
        assert_eq!(names, vec!["github".to_string(), "local".to_string()]);
        assert!(!names
            .iter()
            .any(|n| n.contains("PLANTED-MCP-ENV-VALUE-MUST-NOT-ESCAPE")));
        assert!(mcp_server_names("not json").is_empty());
        assert!(mcp_server_names(r#"{"other": 1}"#).is_empty());
    }

    fn files(pairs: &[(&str, &str)]) -> impl Fn(&PathBuf) -> Option<String> + use<> {
        let owned: Vec<(String, String)> = pairs
            .iter()
            .map(|(p, c)| ((*p).to_string(), (*c).to_string()))
            .collect();
        move |path: &PathBuf| {
            owned
                .iter()
                .find(|(p, _)| PathBuf::from(p) == *path)
                .map(|(_, c)| c.clone())
        }
    }

    const AWS_CREDENTIALS: &str = "[default]\naws_access_key_id = DEFAULTKEY\naws_secret_access_key = DEFAULTSECRET\naws_session_token = DEFAULTSESSION\n\n[work]\naws_access_key_id = WORKKEY\naws_secret_access_key = WORKSECRET\n";

    const AWS_CONFIG: &str =
        "[default]\nregion = us-east-1\n\n[profile work]\nregion = eu-west-2\n";

    #[test]
    fn property_each_aws_credential_field_reads_its_own_ini_key() {
        // One assertion per field: a deleted match arm here would silently stop
        // detecting one kind of credential while the others still worked.
        let env = env_from(&[("HOME", "/home/t")]);
        let read = files(&[("/home/t/.aws/credentials", AWS_CREDENTIALS)]);
        for (field, expected) in [
            ("access_key_id", "DEFAULTKEY"),
            ("secret_access_key", "DEFAULTSECRET"),
            ("session_token", "DEFAULTSESSION"),
        ] {
            assert_eq!(
                detected_aws_file_value(field, &env, &read).as_deref(),
                Some(expected),
                "{field}"
            );
        }
        // A field with no ini key of its own must not fall through to another's.
        assert_eq!(detected_aws_file_value("key_id", &env, &read), None);
    }

    #[test]
    fn contract_the_selected_aws_profile_wins_in_both_files() {
        let env = env_from(&[("HOME", "/home/t"), ("AWS_PROFILE", "work")]);
        let read = files(&[
            ("/home/t/.aws/credentials", AWS_CREDENTIALS),
            ("/home/t/.aws/config", AWS_CONFIG),
        ]);
        assert_eq!(
            detected_aws_file_value("access_key_id", &env, &read).as_deref(),
            Some("WORKKEY")
        );
        // The config file spells a non-default profile "profile work", and the
        // credentials file spells the same profile "work".
        assert_eq!(
            detected_aws_file_value("region", &env, &read).as_deref(),
            Some("eu-west-2")
        );
    }

    #[test]
    fn contract_default_profile_region_is_not_read_from_a_profile_section() {
        let env = env_from(&[("HOME", "/home/t")]);
        let read = files(&[("/home/t/.aws/config", AWS_CONFIG)]);
        assert_eq!(
            detected_aws_file_value("region", &env, &read).as_deref(),
            Some("us-east-1")
        );
    }

    #[test]
    fn property_aws_file_locations_honour_their_overrides() {
        let env = env_from(&[
            ("HOME", "/home/t"),
            ("AWS_SHARED_CREDENTIALS_FILE", "/elsewhere/creds"),
            ("AWS_CONFIG_FILE", "/elsewhere/config"),
        ]);
        let read = files(&[
            ("/elsewhere/creds", AWS_CREDENTIALS),
            ("/elsewhere/config", AWS_CONFIG),
            // The home-relative paths hold something else entirely; reading them
            // would be reading the wrong machine's credentials.
            (
                "/home/t/.aws/credentials",
                "[default]\naws_access_key_id = WRONG\n",
            ),
        ]);
        assert_eq!(
            detected_aws_file_value("access_key_id", &env, &read).as_deref(),
            Some("DEFAULTKEY")
        );
        assert_eq!(
            detected_aws_file_value("region", &env, &read).as_deref(),
            Some("us-east-1")
        );
    }

    #[test]
    fn contract_aws_reads_nothing_when_there_is_no_home_and_no_override() {
        let env = env_from(&[]);
        assert_eq!(
            detected_aws_file_value("access_key_id", &env, &no_files()),
            None
        );
    }

    #[test]
    fn contract_gcp_credentials_come_from_the_override_then_the_default_path() {
        let adc = r#"{"project_id": "proj-from-file"}"#;
        let env = env_from(&[("HOME", "/home/t")]);
        let read = files(&[(
            "/home/t/.config/gcloud/application_default_credentials.json",
            adc,
        )]);
        assert_eq!(detected_gcp_file(&env, &read).as_deref(), Some(adc));

        let overridden = env_from(&[
            ("HOME", "/home/t"),
            ("GOOGLE_APPLICATION_CREDENTIALS", "/keys/sa.json"),
        ]);
        let read_override = files(&[("/keys/sa.json", r#"{"project_id": "proj-override"}"#)]);
        assert_eq!(
            detected_gcp_file(&overridden, &read_override).as_deref(),
            Some(r#"{"project_id": "proj-override"}"#)
        );

        // Nothing configured is not the same as an empty credential.
        assert_eq!(detected_gcp_file(&env_from(&[]), &no_files()), None);
    }

    #[test]
    fn property_gcp_project_id_falls_back_to_the_quota_project() {
        let env = env_from(&[("HOME", "/home/t")]);
        let path = "/home/t/.config/gcloud/application_default_credentials.json";
        let named = files(&[(path, r#"{"project_id": "primary"}"#)]);
        assert_eq!(
            detected_file_value("gcp", "project_id", &env, &named).as_deref(),
            Some("primary")
        );
        let quota_only = files(&[(path, r#"{"quota_project_id": "fallback"}"#)]);
        assert_eq!(
            detected_file_value("gcp", "project_id", &env, &quota_only).as_deref(),
            Some("fallback")
        );
        let neither = files(&[(path, r#"{"client_email": "x@y.z"}"#)]);
        assert_eq!(
            detected_file_value("gcp", "project_id", &env, &neither),
            None
        );
    }

    #[test]
    fn contract_token_dotfiles_are_read_per_provider() {
        let env = env_from(&[("HOME", "/home/t")]);
        let read = files(&[
            ("/home/t/.vault-token", "vault-token-value"),
            ("/home/t/.bao-token", "bao-token-value"),
        ]);
        assert_eq!(
            detected_file_value("vault", "token", &env, &read).as_deref(),
            Some("vault-token-value")
        );
        assert_eq!(
            detected_file_value("openbao", "token", &env, &read).as_deref(),
            Some("bao-token-value")
        );
        // A provider with no file convention must not borrow another's.
        assert_eq!(detected_file_value("stripe", "api_key", &env, &read), None);
    }

    #[test]
    fn adversarial_a_source_is_listed_once_however_many_names_match() {
        // huggingface has two aliases; setting both must not report the same
        // provider twice, and must not collapse two distinct variables into one.
        let env = env_from(&[
            ("HF_TOKEN", "a"),
            ("HUGGING_FACE_HUB_TOKEN", "b"),
            ("OPENSESAME_PROVIDER_HUGGINGFACE_API_KEY", "c"),
        ]);
        let found = scan(&env, &no_files());
        let hf: Vec<_> = found
            .iter()
            .filter(|d| d.provider_id == "huggingface")
            .collect();
        assert_eq!(hf.len(), 1, "one entry per provider");
        let mut names: Vec<&str> = hf[0].sources.iter().map(|s| s.name.as_str()).collect();
        names.sort_unstable();
        assert_eq!(
            names,
            vec![
                "HF_TOKEN",
                "HUGGING_FACE_HUB_TOKEN",
                "OPENSESAME_PROVIDER_HUGGINGFACE_API_KEY"
            ]
        );
    }

    #[test]
    fn property_aws_predicates_name_exactly_the_aws_providers_and_fields() {
        // These gate whether environment credentials suppress a file read, so a
        // predicate that answered true for everything would mix two machines'
        // AWS keys together.
        for id in ["aws", "aws-kms", "aws-ps", "aws-bedrock"] {
            assert!(is_aws_provider(id), "{id}");
        }
        for id in ["stripe", "gcp", "azure-sm", ""] {
            assert!(!is_aws_provider(id), "{id}");
        }
        for field in ["access_key_id", "secret_access_key", "session_token"] {
            assert!(is_aws_credential_field(field), "{field}");
        }
        for field in ["region", "key_id", ""] {
            assert!(!is_aws_credential_field(field), "{field}");
        }
    }

    #[test]
    fn contract_file_detection_routes_each_provider_to_its_own_reader() {
        let env = env_from(&[("HOME", "/home/t")]);
        let read = files(&[
            ("/home/t/.aws/credentials", AWS_CREDENTIALS),
            (
                "/home/t/.config/gcloud/application_default_credentials.json",
                r#"{"project_id": "p"}"#,
            ),
        ]);
        // Reached through the router rather than the reader, so deleting the
        // arm that routes there is caught.
        assert_eq!(
            detected_file_value("aws-bedrock", "access_key_id", &env, &read).as_deref(),
            Some("DEFAULTKEY")
        );
        assert_eq!(
            detected_file_value("gcp-kms", "service_account_json", &env, &read).as_deref(),
            Some(r#"{"project_id": "p"}"#)
        );
    }

    #[test]
    fn chaos_ini_parsing_ignores_comments_and_other_sections() {
        let ini = "[default]\n# hash comment = NOPE\n; semicolon comment = NOPE\naws_access_key_id = AKIAEXAMPLE\n\n[other]\naws_access_key_id = NOPE\n";
        assert_eq!(
            ini_value(ini, "default", "aws_access_key_id").as_deref(),
            Some("AKIAEXAMPLE")
        );
        assert_eq!(ini_value(ini, "missing", "aws_access_key_id"), None);
        // Both comment markers must be skipped inside the matching section, or a
        // commented-out line becomes a credential.
        assert_eq!(ini_value(ini, "default", "# hash comment"), None);
        assert_eq!(ini_value(ini, "default", "; semicolon comment"), None);
    }

    // ——— Capability-moded offers (ADR 0047, offer schema v1) ——————————

    use std::sync::Arc;

    /// A real temporary home directory: the probes read through `std::fs`,
    /// so fixtures have to live on disk. Removed on drop.
    struct TempHome(PathBuf);

    impl TempHome {
        fn new(tag: &str) -> Self {
            let dir = std::env::temp_dir().join(format!(
                "opensesame-connection-detect-test-{}-{tag}",
                std::process::id()
            ));
            std::fs::create_dir_all(&dir).expect("create temp home");
            Self(dir)
        }

        fn write(&self, relative: &str, contents: &str) {
            let path = self.0.join(relative);
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent).expect("create parent");
            }
            std::fs::write(path, contents).expect("write fixture");
        }
    }

    impl Drop for TempHome {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn probe_ctx(home: &TempHome, env: &[(&str, &str)]) -> ProbeContext {
        ProbeContext {
            home_dir: home.0.clone(),
            env: env
                .iter()
                .map(|(k, v)| ((*k).to_string(), (*v).to_string()))
                .collect(),
            keychain: Arc::new(MockKeychain::new()),
            commands: Arc::new(MockCommandRunner::new()),
            max_read_bytes: 8 * 1024,
        }
    }

    /// One report touching every ProbeSource variant, shared by the round-trip
    /// and wire-shape pins so they cannot drift apart.
    fn sample_report() -> ProbeReport {
        ProbeReport {
            schema_version: OFFER_SCHEMA_VERSION,
            host_label: "node-1".to_string(),
            probed_at_unix: 1_750_000_000,
            items: vec![
                OfferItem {
                    provider_id: "github".to_string(),
                    source: ProbeSource::EnvVar {
                        name: "GITHUB_TOKEN".to_string(),
                    },
                    capabilities: vec![CapabilityClass::Importable, CapabilityClass::Mintable],
                    confidence: Confidence::High,
                    registry_hint: None,
                },
                OfferItem {
                    provider_id: "vault".to_string(),
                    source: ProbeSource::DotFile {
                        path: PathBuf::from("/home/t/.vault-token"),
                    },
                    capabilities: vec![CapabilityClass::Importable],
                    confidence: Confidence::Medium,
                    registry_hint: None,
                },
                OfferItem {
                    provider_id: "github".to_string(),
                    source: ProbeSource::Keychain {
                        store: KeychainStore::SecretService,
                        item_label: "GitHub CLI".to_string(),
                    },
                    capabilities: vec![CapabilityClass::Importable],
                    confidence: Confidence::Low,
                    registry_hint: Some("github".to_string()),
                },
                OfferItem {
                    provider_id: "github".to_string(),
                    source: ProbeSource::McpConfig {
                        path: PathBuf::from("/home/t/.mcp.json"),
                        server_name: "github".to_string(),
                        env_keys: vec!["GITHUB_TOKEN".to_string()],
                    },
                    capabilities: vec![CapabilityClass::Importable],
                    confidence: Confidence::Medium,
                    registry_hint: None,
                },
                OfferItem {
                    provider_id: "stripe".to_string(),
                    source: ProbeSource::CliTool {
                        binary: "stripe".to_string(),
                        version: Some("1.19.4".to_string()),
                    },
                    capabilities: vec![CapabilityClass::InvokeThrough],
                    confidence: Confidence::Medium,
                    registry_hint: None,
                },
            ],
        }
    }

    #[test]
    fn contract_offer_report_serde_round_trips() {
        let report = sample_report();
        let json = serde_json::to_string(&report).expect("serializable");
        let back: ProbeReport = serde_json::from_str(&json).expect("deserializable");
        assert_eq!(report, back);
    }

    #[test]
    fn contract_offer_report_wire_shape_is_pinned() {
        // No insta in this crate, so the pin is an explicit comparison. A new
        // key here is a disclosure decision — read the diff if this fails.
        let value = serde_json::to_value(sample_report()).expect("serializable");
        assert_eq!(
            value,
            serde_json::json!({
                "schema_version": 1,
                "host_label": "node-1",
                "probed_at_unix": 1_750_000_000_u64,
                "items": [
                    {
                        "provider_id": "github",
                        "source": { "kind": "env_var", "name": "GITHUB_TOKEN" },
                        "capabilities": ["importable", "mintable"],
                        "confidence": "high",
                        "registry_hint": null,
                    },
                    {
                        "provider_id": "vault",
                        "source": { "kind": "dot_file", "path": "/home/t/.vault-token" },
                        "capabilities": ["importable"],
                        "confidence": "medium",
                        "registry_hint": null,
                    },
                    {
                        "provider_id": "github",
                        "source": {
                            "kind": "keychain",
                            "store": "secret_service",
                            "item_label": "GitHub CLI",
                        },
                        "capabilities": ["importable"],
                        "confidence": "low",
                        "registry_hint": "github",
                    },
                    {
                        "provider_id": "github",
                        "source": {
                            "kind": "mcp_config",
                            "path": "/home/t/.mcp.json",
                            "server_name": "github",
                            "env_keys": ["GITHUB_TOKEN"],
                        },
                        "capabilities": ["importable"],
                        "confidence": "medium",
                        "registry_hint": null,
                    },
                    {
                        "provider_id": "stripe",
                        "source": { "kind": "cli_tool", "binary": "stripe", "version": "1.19.4" },
                        "capabilities": ["invoke_through"],
                        "confidence": "medium",
                        "registry_hint": null,
                    },
                ],
            })
        );
        for (store, wire) in [
            (KeychainStore::SecretService, "secret_service"),
            (KeychainStore::MacOsKeychain, "mac_os_keychain"),
            (
                KeychainStore::WindowsCredentialManager,
                "windows_credential_manager",
            ),
        ] {
            assert_eq!(
                serde_json::to_value(store).unwrap(),
                serde_json::json!(wire)
            );
        }
    }

    #[test]
    fn property_capability_class_orders_importable_through_mintable() {
        assert!(CapabilityClass::Importable < CapabilityClass::InvokeThrough);
        assert!(CapabilityClass::InvokeThrough < CapabilityClass::Mintable);
        let caps = [
            CapabilityClass::Importable,
            CapabilityClass::Mintable,
            CapabilityClass::InvokeThrough,
        ];
        assert_eq!(caps.iter().max(), Some(&CapabilityClass::Mintable));

        let item = OfferItem {
            provider_id: "github".to_string(),
            source: ProbeSource::EnvVar {
                name: "GITHUB_TOKEN".to_string(),
            },
            capabilities: vec![CapabilityClass::Importable, CapabilityClass::Mintable],
            confidence: Confidence::High,
            registry_hint: None,
        };
        assert_eq!(preferred_capability(&item), Some(CapabilityClass::Mintable));
        let empty = OfferItem {
            capabilities: Vec::new(),
            ..item.clone()
        };
        assert_eq!(preferred_capability(&empty), None);
    }

    #[test]
    fn property_mint_capable_names_exactly_the_native_mint_providers() {
        assert_eq!(MINT_CAPABLE_PROVIDERS.len(), 7);
        for id in [
            "github",
            "aws",
            "aws-kms",
            "aws-ps",
            "aws-bedrock",
            "gcp",
            "gcp-kms",
        ] {
            assert!(mint_capable(id), "{id}");
        }
        for id in ["stripe", "azure-sm", "openai", "gitlab", ""] {
            assert!(!mint_capable(id), "{id}");
        }
    }

    #[test]
    fn property_env_dotfile_probe_confidence_and_mint_capability() {
        let home = TempHome::new("env-dotfile");
        let ctx = probe_ctx(
            &home,
            &[
                ("STRIPE_SECRET_KEY", "x"),
                ("OPENSESAME_PROVIDER_STRIPE_API_KEY", "y"),
                ("GITHUB_TOKEN", "z"),
            ],
        );
        let items = EnvDotfileProbe.probe(&ctx).expect("env probe");

        let explicit = items
            .iter()
            .find(|i| {
                matches!(&i.source, ProbeSource::EnvVar { name } if name == "OPENSESAME_PROVIDER_STRIPE_API_KEY")
            })
            .expect("explicit variable reported");
        assert_eq!(explicit.confidence, Confidence::High);
        assert_eq!(explicit.capabilities, vec![CapabilityClass::Importable]);
        assert_eq!(explicit.registry_hint, None);

        let conventional = items
            .iter()
            .find(|i| {
                matches!(&i.source, ProbeSource::EnvVar { name } if name == "STRIPE_SECRET_KEY")
            })
            .expect("conventional variable reported");
        assert_eq!(conventional.confidence, Confidence::Medium);

        // A mint-capable provider offers Mintable alongside Importable, and
        // the preferred capability is the mint path.
        let github = items
            .iter()
            .find(|i| i.provider_id == "github")
            .expect("github reported");
        assert_eq!(
            github.capabilities,
            vec![CapabilityClass::Importable, CapabilityClass::Mintable]
        );
        assert_eq!(
            preferred_capability(github),
            Some(CapabilityClass::Mintable)
        );
    }

    #[test]
    fn property_env_dotfile_probe_resolves_dotfile_paths() {
        let home = TempHome::new("dotfile");
        home.write(".vault-token", "vault-token-value");
        let ctx = probe_ctx(&home, &[]);
        let items = EnvDotfileProbe.probe(&ctx).expect("env probe");
        let vault = items
            .iter()
            .find(|i| i.provider_id == "vault")
            .expect("vault dotfile reported");
        assert_eq!(
            vault.source,
            ProbeSource::DotFile {
                path: home.0.join(".vault-token")
            }
        );
        assert_eq!(vault.confidence, Confidence::Medium);
    }

    #[test]
    fn adversarial_mcp_probe_collects_env_key_names_never_values() {
        let home = TempHome::new("mcp-keys");
        home.write(
            ".mcp.json",
            r#"{"mcpServers": {
              "github": { "command": "npx", "env": { "GITHUB_TOKEN": "PLANTED-MCP-VALUE-MUST-NOT-ESCAPE", "GITHUB_HOST": "PLANTED-HOST-VALUE-MUST-NOT-ESCAPE" } },
              "local": { "command": "./server" }
            }}"#,
        );
        let ctx = probe_ctx(&home, &[]);
        let items = McpConfigProbe.probe(&ctx).expect("mcp probe");
        assert_eq!(items.len(), 2, "{items:?}");

        let github = items
            .iter()
            .find(|i| i.provider_id == "github")
            .expect("github server reported");
        assert_eq!(
            github.source,
            ProbeSource::McpConfig {
                path: home.0.join(".mcp.json"),
                server_name: "github".to_string(),
                env_keys: vec!["GITHUB_HOST".to_string(), "GITHUB_TOKEN".to_string()],
            }
        );
        assert_eq!(github.capabilities, vec![CapabilityClass::Importable]);
        assert_eq!(github.confidence, Confidence::Medium);

        let local = items
            .iter()
            .find(|i| i.provider_id == "local")
            .expect("local server reported");
        assert!(
            matches!(&local.source, ProbeSource::McpConfig { env_keys, .. } if env_keys.is_empty())
        );

        let rendered = serde_json::to_string(&items).expect("serializable");
        assert!(rendered.contains("GITHUB_TOKEN"), "key names pass through");
        assert!(!rendered.contains("PLANTED-MCP-VALUE-MUST-NOT-ESCAPE"));
        assert!(!rendered.contains("PLANTED-HOST-VALUE-MUST-NOT-ESCAPE"));
    }

    #[test]
    fn adversarial_mcp_probe_treats_malformed_json_as_empty_not_error() {
        assert!(mcp_server_env_keys("not json").is_empty());
        assert!(mcp_server_env_keys(r#"{"other": 1}"#).is_empty());
        assert!(mcp_server_env_keys(r#"{"mcpServers": [1, 2]}"#).is_empty());

        let home = TempHome::new("mcp-malformed");
        home.write(".mcp.json", "not json {");
        let ctx = probe_ctx(&home, &[]);
        let items = McpConfigProbe
            .probe(&ctx)
            .expect("malformed is not an error");
        assert!(items.is_empty());
    }

    #[test]
    fn adversarial_mcp_probe_skips_files_larger_than_the_read_cap() {
        let home = TempHome::new("mcp-oversized");
        let mut padded = r#"{"mcpServers": {"github": { "command": "npx" }}}"#.to_string();
        padded.push_str(&" ".repeat(1024));
        home.write(".mcp.json", &padded);
        let mut ctx = probe_ctx(&home, &[]);
        ctx.max_read_bytes = 64;
        let items = McpConfigProbe
            .probe(&ctx)
            .expect("oversized is not an error");
        assert!(items.is_empty(), "oversized file skipped, not truncated");
    }

    #[test]
    fn property_merge_offers_unions_capabilities_and_dedups() {
        let env_source = || ProbeSource::EnvVar {
            name: "GITHUB_TOKEN".to_string(),
        };
        let merged = merge_offers(vec![
            OfferItem {
                provider_id: "github".to_string(),
                source: env_source(),
                capabilities: vec![CapabilityClass::Importable],
                confidence: Confidence::Medium,
                registry_hint: None,
            },
            OfferItem {
                provider_id: "github".to_string(),
                source: env_source(),
                capabilities: vec![CapabilityClass::Mintable, CapabilityClass::Importable],
                confidence: Confidence::High,
                registry_hint: Some("gh".to_string()),
            },
            // Same provider, different source: a separate offer.
            OfferItem {
                provider_id: "github".to_string(),
                source: ProbeSource::DotFile {
                    path: PathBuf::from("/home/t/.config/gh/hosts.yml"),
                },
                capabilities: vec![CapabilityClass::Importable],
                confidence: Confidence::Low,
                registry_hint: None,
            },
            // Same MCP server seen twice with different env keys: unioned.
            OfferItem {
                provider_id: "github".to_string(),
                source: ProbeSource::McpConfig {
                    path: PathBuf::from("/home/t/.mcp.json"),
                    server_name: "github".to_string(),
                    env_keys: vec!["GITHUB_TOKEN".to_string()],
                },
                capabilities: vec![CapabilityClass::Importable],
                confidence: Confidence::Medium,
                registry_hint: None,
            },
            OfferItem {
                provider_id: "github".to_string(),
                source: ProbeSource::McpConfig {
                    path: PathBuf::from("/home/t/.mcp.json"),
                    server_name: "github".to_string(),
                    env_keys: vec!["GITHUB_HOST".to_string(), "GITHUB_TOKEN".to_string()],
                },
                capabilities: vec![CapabilityClass::Importable],
                confidence: Confidence::Medium,
                registry_hint: None,
            },
        ]);

        assert_eq!(merged.len(), 3, "{merged:?}");
        // Deterministic order: provider id, then source identity.
        assert!(matches!(&merged[0].source, ProbeSource::DotFile { .. }));
        let env = &merged[1];
        assert!(matches!(&env.source, ProbeSource::EnvVar { .. }));
        assert_eq!(
            env.capabilities,
            vec![CapabilityClass::Importable, CapabilityClass::Mintable],
            "capabilities unioned"
        );
        assert_eq!(env.confidence, Confidence::High, "max confidence wins");
        assert_eq!(env.registry_hint.as_deref(), Some("gh"));
        let mcp = &merged[2];
        assert!(
            matches!(&mcp.source, ProbeSource::McpConfig { env_keys, .. }
                if env_keys == &["GITHUB_HOST".to_string(), "GITHUB_TOKEN".to_string()]),
            "env key names unioned: {:?}",
            mcp.source
        );
    }

    #[test]
    fn adversarial_full_probe_report_never_carries_a_planted_secret() {
        const ENV_CANARY: &str = "PLANTED-ENV-VALUE-MUST-NOT-ESCAPE";
        const FILE_CANARY: &str = "PLANTED-FILE-VALUE-MUST-NOT-ESCAPE";
        const MCP_CANARY: &str = "PLANTED-MCP-VALUE-MUST-NOT-ESCAPE";

        let home = TempHome::new("canary");
        home.write(".vault-token", FILE_CANARY);
        home.write(
            ".mcp.json",
            &format!(
                r#"{{"mcpServers": {{"github": {{ "command": "npx", "env": {{ "GITHUB_TOKEN": "{MCP_CANARY}" }}}} }}}}"#
            ),
        );

        let ctx = ProbeContext {
            keychain: Arc::new(
                MockKeychain::new()
                    .with_label(KeychainStore::SecretService, "GitHub (work laptop)"),
            ),
            ..probe_ctx(&home, &[("STRIPE_SECRET_KEY", ENV_CANARY)])
        };

        let mut items = EnvDotfileProbe.probe(&ctx).expect("env probe");
        items.extend(McpConfigProbe.probe(&ctx).expect("mcp probe"));
        // Keychain labels are display names and pass through BY DESIGN — the
        // canary here is the env/file/MCP values, which must not.
        for (store, label) in ctx.keychain.enumerate_labels().expect("labels") {
            items.push(OfferItem {
                provider_id: "github".to_string(),
                source: ProbeSource::Keychain {
                    store,
                    item_label: label,
                },
                capabilities: vec![CapabilityClass::Importable],
                confidence: Confidence::Low,
                registry_hint: None,
            });
        }

        let report = build_report("test-host".to_string(), 1_750_000_000, merge_offers(items));
        assert_eq!(report.schema_version, OFFER_SCHEMA_VERSION);
        let rendered = serde_json::to_string(&report).expect("serializable");

        assert!(rendered.contains("stripe"), "{rendered}");
        assert!(rendered.contains("STRIPE_SECRET_KEY"));
        assert!(rendered.contains(".vault-token"), "dotfile path reported");
        assert!(
            rendered.contains("GITHUB_TOKEN"),
            "MCP env key name reported"
        );
        assert!(
            rendered.contains("GitHub (work laptop)"),
            "keychain labels are display names and pass through"
        );
        // The contract the offer model lives or dies by.
        assert!(!rendered.contains(ENV_CANARY));
        assert!(!rendered.contains(FILE_CANARY));
        assert!(!rendered.contains(MCP_CANARY));
    }

    #[test]
    fn contract_probes_have_no_network_capability_by_construction() {
        // This is asserted structurally, not behaviorally: ProbeContext
        // carries an env snapshot, a keychain label enumerator, a scrubbed
        // CommandRunner, and a byte cap. There is no socket, HTTP client, or
        // URL field it *could* grow a network call from — a probe that wanted
        // to dial out would have to change this type, which is a contract
        // break visible in the wire-shape pin and this construction.
        let home = TempHome::new("no-network");
        let ctx = probe_ctx(&home, &[]);
        let _ = &ctx.keychain;
        let _ = &ctx.commands;
        let items = EnvDotfileProbe
            .probe(&ctx)
            .expect("probe runs on mocks alone");
        assert!(items.is_empty());
    }
}
