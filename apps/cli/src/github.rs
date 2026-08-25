//! GitHub App auth brokering for the human CLI.
//!
//! Mints short-lived installation tokens from a GitHub App's credentials
//! (RS256 app JWT → `POST /app/installations/{id}/access_tokens`). This is the
//! implementation behind the `github-app` provider lease and the sealed-store
//! `backup` push credential. Tokens are never persisted; they live for the
//! one operation that asked for them.

use anyhow::Context;
use serde::{Deserialize, Serialize};

pub const DEFAULT_API_BASE: &str = "https://api.github.com";
const API_VERSION: &str = "2022-11-28";
const USER_AGENT: &str = "opensesame-cli";

#[derive(Debug, Clone)]
pub struct GitHubAppConfig {
    pub app_id: String,
    pub installation_id: Option<String>,
    pub private_key_pem: String,
    pub api_base: String,
}

impl GitHubAppConfig {
    /// Resolve app credentials from explicit values plus environment fallbacks
    /// (`GITHUB_APP_ID`, `GITHUB_APP_INSTALLATION_ID`, and the private key via
    /// `GITHUB_APP_PRIVATE_KEY` or `GITHUB_APP_PRIVATE_KEY_PATH`).
    pub fn resolve(
        app_id: Option<String>,
        installation_id: Option<String>,
        private_key_path: Option<String>,
    ) -> anyhow::Result<Self> {
        let app_id = app_id
            .or_else(|| non_empty_env("GITHUB_APP_ID"))
            .context("GitHub App id missing — set GITHUB_APP_ID")?;
        let installation_id =
            installation_id.or_else(|| non_empty_env("GITHUB_APP_INSTALLATION_ID"));
        let private_key_pem =
            match private_key_path.or_else(|| non_empty_env("GITHUB_APP_PRIVATE_KEY_PATH")) {
                Some(path) => std::fs::read_to_string(&path)
                    .with_context(|| format!("reading GitHub App private key from {path}"))?,
                None => non_empty_env("GITHUB_APP_PRIVATE_KEY").context(
                    "GitHub App private key missing — set GITHUB_APP_PRIVATE_KEY_PATH (PEM file) \
                 or GITHUB_APP_PRIVATE_KEY (inline PEM)",
                )?,
            };
        Ok(Self {
            app_id,
            installation_id,
            private_key_pem,
            api_base: non_empty_env("GITHUB_API_BASE").unwrap_or_else(|| DEFAULT_API_BASE.into()),
        })
    }

    /// True when the environment carries enough to mint without prompting.
    pub fn env_configured() -> bool {
        non_empty_env("GITHUB_APP_ID").is_some()
            && (non_empty_env("GITHUB_APP_PRIVATE_KEY").is_some()
                || non_empty_env("GITHUB_APP_PRIVATE_KEY_PATH").is_some())
    }
}

#[derive(Debug, Deserialize, Serialize)]
pub struct InstallationToken {
    pub token: String,
    pub expires_at: String,
}

#[derive(Serialize)]
struct AppJwtClaims {
    iat: i64,
    exp: i64,
    iss: String,
}

/// The app JWT GitHub expects: RS256, issued by the app id, ≤10 min lifetime.
/// 60 s of backdating absorbs clock skew, per GitHub's own guidance.
fn mint_app_jwt(config: &GitHubAppConfig) -> anyhow::Result<String> {
    let key = jsonwebtoken::EncodingKey::from_rsa_pem(config.private_key_pem.as_bytes())
        .context("GitHub App private key is not a valid RSA PEM")?;
    let now = chrono::Utc::now().timestamp();
    let claims = AppJwtClaims {
        iat: now - 60,
        exp: now + 540,
        iss: config.app_id.clone(),
    };
    let header = jsonwebtoken::Header::new(jsonwebtoken::Algorithm::RS256);
    jsonwebtoken::encode(&header, &claims, &key).context("signing GitHub App JWT")
}

#[derive(Deserialize)]
struct Installation {
    id: u64,
}

/// Mint an installation access token. When the config names no installation,
/// a single-installation app resolves it automatically; multiple installations
/// are an error that lists the choices rather than a guess.
pub async fn mint_installation_token(
    config: &GitHubAppConfig,
) -> anyhow::Result<InstallationToken> {
    let jwt = mint_app_jwt(config)?;
    let client = reqwest::Client::new();
    let base = config.api_base.trim_end_matches('/');
    let installation_id = if let Some(id) = &config.installation_id {
        id.clone()
    } else {
        let installations: Vec<Installation> = client
            .get(format!("{base}/app/installations"))
            .bearer_auth(&jwt)
            .header("accept", "application/vnd.github+json")
            .header("x-github-api-version", API_VERSION)
            .header("user-agent", USER_AGENT)
            .send()
            .await?
            .error_for_status()
            .context("listing GitHub App installations")?
            .json()
            .await?;
        match installations.as_slice() {
            [only] => only.id.to_string(),
            [] => anyhow::bail!(
                "the GitHub App has no installations — install it on the account \
                 that owns the backup repository"
            ),
            many => anyhow::bail!(
                "the GitHub App has {} installations — set GITHUB_APP_INSTALLATION_ID \
                 to one of: {}",
                many.len(),
                many.iter()
                    .map(|i| i.id.to_string())
                    .collect::<Vec<_>>()
                    .join(", ")
            ),
        }
    };
    let token: InstallationToken = client
        .post(format!(
            "{base}/app/installations/{installation_id}/access_tokens"
        ))
        .bearer_auth(&jwt)
        .header("accept", "application/vnd.github+json")
        .header("x-github-api-version", API_VERSION)
        .header("user-agent", USER_AGENT)
        .send()
        .await?
        .error_for_status()
        .context("minting GitHub App installation token")?
        .json()
        .await?;
    Ok(token)
}

/// Resolve a push credential for GitHub HTTPS remotes, most explicit first:
/// `GITHUB_TOKEN` / `GH_TOKEN`, then GitHub App credentials from the
/// environment, then an ambient `gh auth token`. `None` falls back to git's
/// own credential helpers.
pub async fn resolve_push_token() -> Option<String> {
    if let Some(token) = non_empty_env("GITHUB_TOKEN").or_else(|| non_empty_env("GH_TOKEN")) {
        return Some(token);
    }
    if GitHubAppConfig::env_configured() {
        match GitHubAppConfig::resolve(None, None, None) {
            Ok(config) => match mint_installation_token(&config).await {
                Ok(minted) => return Some(minted.token),
                Err(error) => {
                    eprintln!("warning: GitHub App token mint failed: {error:#}");
                }
            },
            Err(error) => eprintln!("warning: GitHub App config incomplete: {error:#}"),
        }
    }
    let output = std::process::Command::new("gh")
        .args(["auth", "token"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let token = String::from_utf8_lossy(&output.stdout).trim().to_string();
    (!token.is_empty()).then_some(token)
}

fn non_empty_env(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|value| !value.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Fresh throwaway key per run — a committed PEM would trip the gitleaks
    /// gate and repo policy (keys live outside git).
    fn throwaway_rsa_pem() -> Option<String> {
        let output = std::process::Command::new("openssl")
            .args(["genrsa", "2048"])
            .output()
            .ok()?;
        if !output.status.success() {
            return None;
        }
        String::from_utf8(output.stdout).ok()
    }

    #[test]
    #[expect(
        clippy::items_after_statements,
        reason = "the test-local decoding import belongs beside the assertion that uses it"
    )]
    fn app_jwt_is_rs256_with_app_id_issuer() {
        let Some(pem) = throwaway_rsa_pem() else {
            eprintln!("skipping: openssl unavailable");
            return;
        };
        let config = GitHubAppConfig {
            app_id: "12345".into(),
            installation_id: None,
            private_key_pem: pem,
            api_base: DEFAULT_API_BASE.into(),
        };
        let jwt = mint_app_jwt(&config).unwrap();
        let parts: Vec<&str> = jwt.split('.').collect();
        assert_eq!(parts.len(), 3);
        use base64::Engine as _;
        let engine = base64::engine::general_purpose::URL_SAFE_NO_PAD;
        let header: serde_json::Value =
            serde_json::from_slice(&engine.decode(parts[0]).unwrap()).unwrap();
        assert_eq!(header["alg"], "RS256");
        let claims: serde_json::Value =
            serde_json::from_slice(&engine.decode(parts[1]).unwrap()).unwrap();
        assert_eq!(claims["iss"], "12345");
        let lifetime = claims["exp"].as_i64().unwrap() - claims["iat"].as_i64().unwrap();
        assert_eq!(lifetime, 600, "GitHub caps app JWTs at 10 minutes");
    }

    #[test]
    fn resolve_requires_an_app_id() {
        // No explicit values and (in tests) no env — must fail with the fix named.
        if std::env::var("GITHUB_APP_ID").is_ok() {
            return; // environment already configured; nothing to assert
        }
        let err = GitHubAppConfig::resolve(None, None, None).unwrap_err();
        assert!(err.to_string().contains("GITHUB_APP_ID"));
    }

    #[test]
    fn a_garbage_key_fails_closed() {
        let config = GitHubAppConfig {
            app_id: "1".into(),
            installation_id: None,
            private_key_pem: "not a pem".into(),
            api_base: DEFAULT_API_BASE.into(),
        };
        assert!(mint_app_jwt(&config).is_err());
    }
}
