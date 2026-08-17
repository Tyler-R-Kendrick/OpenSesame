//! Server-side GitHub App installation tokens (ADR 0039).
//!
//! The backup actor authenticates as the org-installed GitHub App: an RS256
//! app JWT signed with the sealed private key, exchanged for a short-lived
//! installation access token. Tokens are cached in memory until shortly
//! before expiry and never persisted or exposed through any route.

use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};

pub const DEFAULT_GITHUB_API_BASE: &str = "https://api.github.com";
const API_VERSION: &str = "2022-11-28";
const USER_AGENT: &str = "opensesame-gateway";
/// Refresh this long before GitHub's stated expiry so an in-flight batch
/// never runs off the end of its token.
const EXPIRY_MARGIN_SECONDS: i64 = 300;

#[derive(Clone)]
pub struct GithubAppSigningMaterial {
    pub app_id: String,
    pub private_key_pem: String,
}

impl std::fmt::Debug for GithubAppSigningMaterial {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("GithubAppSigningMaterial")
            .field("app_id", &self.app_id)
            .field("private_key_pem", &"[sealed]")
            .finish()
    }
}

#[derive(Clone, Debug, Deserialize)]
pub struct InstallationToken {
    pub token: String,
    pub expires_at: DateTime<Utc>,
}

impl InstallationToken {
    pub fn usable(&self) -> bool {
        Utc::now() + Duration::seconds(EXPIRY_MARGIN_SECONDS) < self.expires_at
    }
}

#[derive(Serialize)]
struct AppJwtClaims {
    iat: i64,
    exp: i64,
    iss: String,
}

/// The app JWT GitHub expects: RS256, issued by the app id, ≤10 min lifetime,
/// backdated 60 s to absorb clock skew (GitHub's own guidance).
pub fn mint_app_jwt(material: &GithubAppSigningMaterial) -> anyhow::Result<String> {
    let key = jsonwebtoken::EncodingKey::from_rsa_pem(material.private_key_pem.as_bytes())
        .map_err(|e| anyhow::anyhow!("GitHub App private key is not a valid RSA PEM: {e}"))?;
    let now = Utc::now().timestamp();
    let claims = AppJwtClaims {
        iat: now - 60,
        exp: now + 540,
        iss: material.app_id.clone(),
    };
    let header = jsonwebtoken::Header::new(jsonwebtoken::Algorithm::RS256);
    jsonwebtoken::encode(&header, &claims, &key)
        .map_err(|e| anyhow::anyhow!("signing GitHub App JWT: {e}"))
}

/// Errors the actor compensates differently: `Suspended` means the App or its
/// installation is gone and retrying cannot help until a human reconfigures.
#[derive(Debug, thiserror::Error)]
pub enum MintError {
    #[error("GitHub App installation is unavailable: {0}")]
    Suspended(String),
    #[error("{0}")]
    Transient(anyhow::Error),
}

pub async fn mint_installation_token(
    http: &reqwest::Client,
    api_base: &str,
    material: &GithubAppSigningMaterial,
    installation_id: &str,
) -> Result<InstallationToken, MintError> {
    let jwt = mint_app_jwt(material).map_err(MintError::Transient)?;
    let base = api_base.trim_end_matches('/');
    let response = http
        .post(format!(
            "{base}/app/installations/{installation_id}/access_tokens"
        ))
        .bearer_auth(&jwt)
        .header("accept", "application/vnd.github+json")
        .header("x-github-api-version", API_VERSION)
        .header("user-agent", USER_AGENT)
        .send()
        .await
        .map_err(|e| MintError::Transient(e.into()))?;
    match response.status().as_u16() {
        201 => response
            .json::<InstallationToken>()
            .await
            .map_err(|e| MintError::Transient(e.into())),
        // The app was uninstalled, the installation revoked, or the key
        // rotated: retrying without human intervention cannot succeed.
        401 | 403 | 404 => Err(MintError::Suspended(format!(
            "installation token mint returned {}",
            response.status()
        ))),
        status => Err(MintError::Transient(anyhow::anyhow!(
            "installation token mint returned {status}"
        ))),
    }
}

/// Summary of a GitHub App installation (never includes tokens).
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct GithubInstallationSummary {
    pub id: String,
    pub account_login: String,
    pub account_type: String,
    pub target_type: String,
}

#[derive(Deserialize)]
struct GithubInstallationApiRow {
    id: u64,
    account: GithubInstallationAccount,
    #[serde(default)]
    target_type: Option<String>,
}

#[derive(Deserialize)]
struct GithubInstallationAccount {
    login: String,
    #[serde(rename = "type")]
    account_type: String,
}

/// List installations for a GitHub App (JWT auth). Used by backup setup UX.
pub async fn list_app_installations(
    http: &reqwest::Client,
    api_base: &str,
    material: &GithubAppSigningMaterial,
) -> Result<Vec<GithubInstallationSummary>, MintError> {
    let jwt = mint_app_jwt(material).map_err(MintError::Transient)?;
    let base = api_base.trim_end_matches('/');
    let response = http
        .get(format!("{base}/app/installations"))
        .bearer_auth(&jwt)
        .header("accept", "application/vnd.github+json")
        .header("x-github-api-version", API_VERSION)
        .header("user-agent", USER_AGENT)
        .query(&[("per_page", "100")])
        .send()
        .await
        .map_err(|e| MintError::Transient(e.into()))?;
    match response.status().as_u16() {
        200 => {
            let rows: Vec<GithubInstallationApiRow> = response
                .json()
                .await
                .map_err(|e| MintError::Transient(e.into()))?;
            Ok(rows
                .into_iter()
                .map(|row| GithubInstallationSummary {
                    id: row.id.to_string(),
                    account_login: row.account.login,
                    account_type: row.account.account_type,
                    target_type: row.target_type.unwrap_or_else(|| "Unknown".into()),
                })
                .collect())
        }
        401 | 403 | 404 => Err(MintError::Suspended(format!(
            "list installations returned {}",
            response.status()
        ))),
        status => Err(MintError::Transient(anyhow::anyhow!(
            "list installations returned {status}"
        ))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn throwaway_rsa_pem() -> Option<String> {
        let output = std::process::Command::new("openssl")
            .args(["genrsa", "2048"])
            .output()
            .ok()?;
        output
            .status
            .success()
            .then(|| String::from_utf8(output.stdout).ok())?
    }

    #[test]
    fn app_jwt_is_rs256_issued_by_the_app() {
        let Some(pem) = throwaway_rsa_pem() else {
            eprintln!("skipping: openssl unavailable");
            return;
        };
        let material = GithubAppSigningMaterial {
            app_id: "4242".into(),
            private_key_pem: pem,
        };
        let jwt = mint_app_jwt(&material).unwrap();
        let parts: Vec<&str> = jwt.split('.').collect();
        assert_eq!(parts.len(), 3);
        use base64::Engine as _;
        let engine = base64::engine::general_purpose::URL_SAFE_NO_PAD;
        let header: serde_json::Value =
            serde_json::from_slice(&engine.decode(parts[0]).unwrap()).unwrap();
        assert_eq!(header["alg"], "RS256");
        let claims: serde_json::Value =
            serde_json::from_slice(&engine.decode(parts[1]).unwrap()).unwrap();
        assert_eq!(claims["iss"], "4242");
        assert_eq!(
            claims["exp"].as_i64().unwrap() - claims["iat"].as_i64().unwrap(),
            600,
            "GitHub caps app JWTs at 10 minutes"
        );
    }

    #[test]
    fn a_garbage_key_fails_closed() {
        let material = GithubAppSigningMaterial {
            app_id: "1".into(),
            private_key_pem: "not a pem".into(),
        };
        assert!(mint_app_jwt(&material).is_err());
    }

    #[test]
    fn debug_never_prints_the_key() {
        let material = GithubAppSigningMaterial {
            app_id: "1".into(),
            private_key_pem: "-----BEGIN RSA PRIVATE KEY-----secret".into(),
        };
        assert!(!format!("{material:?}").contains("secret"));
    }

    #[test]
    fn tokens_expire_with_margin() {
        let live = InstallationToken {
            token: "t".into(),
            expires_at: Utc::now() + Duration::hours(1),
        };
        assert!(live.usable());
        let dying = InstallationToken {
            token: "t".into(),
            expires_at: Utc::now() + Duration::seconds(60),
        };
        assert!(!dying.usable());
    }
}
