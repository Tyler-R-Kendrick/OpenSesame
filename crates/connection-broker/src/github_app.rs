//! Tenant GitHub App provisioning via the GitHub App Manifest flow.
//!
//! Operators never paste client id/secret by hand: OpenSesame posts a manifest,
//! GitHub creates the app under the operator's account, and the Host seals the
//! resulting credentials as an organization integration (ADR 0035).

use serde::Deserialize;
use serde_json::{json, Map, Value};

use crate::config::BrokerConfig;
use crate::error::BrokerError;
use crate::Result;

pub const GITHUB_APP_REGISTER_URL: &str = "https://github.com/settings/apps/new";
pub const GITHUB_APP_MANIFEST_CONVERSIONS: &str = "https://api.github.com/app-manifests";

/// GitHub App client ids are `Iv1.` / `Iv23`… Classic OAuth apps use other forms.
pub fn is_github_app_client_id(client_id: &str) -> bool {
    let id = client_id.trim();
    id.starts_with("Iv1.") || id.starts_with("Iv23")
}

/// Repository permissions for sealed-store History (create / list / clone / push).
///
/// Classic OAuth `scope=repo` does **not** map onto GitHub App Administration.
/// These fine-grained permissions are what the Manifest registers on the App and
/// what user-to-server Authorize must grant (by omitting classic `scope=`).
pub fn history_app_permissions() -> Value {
    json!({
        // List repos + identify the account.
        "metadata": "read",
        // Git clone / fetch / push and Contents API (ciphertext blobs).
        "contents": "write",
        // POST /user/repos — create the private password-store repository.
        "administration": "write",
        // Push updates under `.github/workflows` when a store tracks Actions files.
        "workflows": "write",
        // Catalog operation pull_request.create (optional History tooling).
        "pull_requests": "write"
    })
}

/// Integration scope ceiling stored for GitHub App credentials.
/// Classic-looking names so Pages / require_scope_subset keep working; Authorize
/// for GitHub Apps still omits `scope=` so the App permissions above are used.
pub fn history_integration_scopes() -> Vec<String> {
    vec![
        "read:user".into(),
        "repo".into(),
        "read:org".into(),
        "workflow".into(),
    ]
}

fn public_url_is_loopback(public_url: &str) -> bool {
    let Ok(url) = url::Url::parse(public_url) else {
        return false;
    };
    matches!(
        url.host_str(),
        Some("127.0.0.1") | Some("localhost") | Some("::1")
    )
}

/// Loopback Hosts accept OAuth callbacks on both `127.0.0.1` and `localhost`
/// so Pages (often on `localhost`) and the Host public_url stay interchangeable.
fn oauth_callback_urls(config: &BrokerConfig) -> Vec<String> {
    let primary = config.callback_url("github");
    let mut urls = vec![primary.clone()];
    if !public_url_is_loopback(config.public_url()) {
        return urls;
    }
    if let Ok(mut url) = url::Url::parse(&primary) {
        let alt_host = match url.host_str() {
            Some("127.0.0.1") => Some("localhost"),
            Some("localhost") => Some("127.0.0.1"),
            _ => None,
        };
        if let Some(host) = alt_host {
            if url.set_host(Some(host)).is_ok() {
                let alt = url.to_string();
                if alt != primary {
                    urls.push(alt);
                }
            }
        }
    }
    urls
}

/// Build the manifest GitHub expects for `POST /settings/apps/new`.
///
/// GitHub rejects webhook URLs that are not reachable on the public Internet.
/// Local Host (`127.0.0.1` / `localhost`) therefore omits `hook_attributes` —
/// History OAuth does not need webhooks. Public Host URLs (Tailscale Serve,
/// etc.) still register an inactive webhook pointing at this deployment.
///
/// `redirect_url` is the Manifest conversion callback on the Host.
/// `setup_url` is where GitHub sends the operator after **Install App**
/// (Pages Settings) — it must not be the conversion callback (needs `state`).
pub fn build_manifest(
    config: &BrokerConfig,
    display_name: &str,
    redirect_url: &str,
    setup_url: &str,
) -> Value {
    let loopback = public_url_is_loopback(config.public_url());
    // Homepage must be a URL GitHub accepts; loopback Host public_url is fine
    // for `url` (not a webhook), but prefer an https homepage when we omit hooks
    // so the create form does not look like a broken server address.
    let homepage = if loopback {
        "https://github.com"
    } else {
        config.public_url()
    };

    let mut manifest = Map::new();
    manifest.insert("name".into(), json!(display_name));
    manifest.insert("url".into(), json!(homepage));
    manifest.insert("redirect_url".into(), json!(redirect_url));
    manifest.insert("callback_urls".into(), json!(oauth_callback_urls(config)));
    manifest.insert("setup_url".into(), json!(setup_url));
    manifest.insert("public".into(), json!(false));
    // Local create/confirm should not force an install OAuth hop before the
    // operator finishes App registration and returns to Pages.
    manifest.insert("request_oauth_on_install".into(), json!(!loopback));
    manifest.insert("default_permissions".into(), history_app_permissions());
    manifest.insert("default_events".into(), json!([]));

    if !loopback {
        let webhook = format!("{}/api/v1/webhooks/github", config.public_url());
        manifest.insert(
            "hook_attributes".into(),
            json!({
                "url": webhook,
                "active": false
            }),
        );
    }

    Value::Object(manifest)
}

#[derive(Debug, Clone, Deserialize)]
pub struct GithubAppCredentials {
    pub id: i64,
    pub name: String,
    pub client_id: String,
    pub client_secret: String,
    #[serde(default)]
    pub html_url: Option<String>,
    #[serde(default)]
    pub pem: Option<String>,
    #[serde(default)]
    pub webhook_secret: Option<String>,
}

/// Exchange the temporary manifest `code` for app credentials.
pub async fn convert_manifest_code(
    http: &reqwest::Client,
    code: &str,
) -> Result<GithubAppCredentials> {
    let code = code.trim();
    if code.is_empty() {
        return Err(BrokerError::Invalid("manifest code is required".into()));
    }
    let url = format!("{GITHUB_APP_MANIFEST_CONVERSIONS}/{code}/conversions");
    let res = http
        .post(&url)
        .header("Accept", "application/vnd.github+json")
        .header("User-Agent", "OpenSesame-Host/0.1")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .send()
        .await
        .map_err(|e| BrokerError::ExchangeFailed(e.to_string()))?;
    let status = res.status();
    let text = res
        .text()
        .await
        .map_err(|e| BrokerError::ExchangeFailed(e.to_string()))?;
    if !(200..300).contains(&status.as_u16()) {
        let snippet: String = text.chars().take(200).collect();
        return Err(BrokerError::ExchangeFailed(format!(
            "GitHub App manifest conversion failed ({status}): {snippet}"
        )));
    }
    serde_json::from_str(&text).map_err(|e| {
        BrokerError::ExchangeFailed(format!("invalid GitHub App conversion response: {e}"))
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::BrokerConfig;

    #[test]
    fn manifest_points_oauth_and_manifest_callbacks_at_this_host() {
        let config = BrokerConfig::in_memory(Some([7u8; 32]), "http://127.0.0.1:18787");
        let manifest = build_manifest(
            &config,
            "OpenSesame local",
            "http://127.0.0.1:18787/api/v1/oauth/github-app/callback",
            "http://localhost:5180/OpenSesame/settings?github_app=installed",
        );
        assert_eq!(
            manifest["callback_urls"][0],
            "http://127.0.0.1:18787/api/v1/oauth/callback/github"
        );
        assert_eq!(
            manifest["callback_urls"][1],
            "http://localhost:18787/api/v1/oauth/callback/github"
        );
        assert_eq!(
            manifest["redirect_url"],
            "http://127.0.0.1:18787/api/v1/oauth/github-app/callback"
        );
        assert_eq!(
            manifest["setup_url"],
            "http://localhost:5180/OpenSesame/settings?github_app=installed"
        );
        assert_eq!(manifest["default_permissions"]["contents"], "write");
        assert_eq!(manifest["default_permissions"]["administration"], "write");
        assert_eq!(manifest["default_permissions"]["workflows"], "write");
        assert_eq!(manifest["default_permissions"]["pull_requests"], "write");
        assert_eq!(manifest["default_permissions"]["metadata"], "read");
        assert_eq!(manifest["request_oauth_on_install"], false);
        // Loopback Host cannot receive GitHub webhooks — omit hooks entirely.
        assert!(manifest.get("hook_attributes").is_none());
        assert_eq!(manifest["url"], "https://github.com");
    }

    #[test]
    fn manifest_registers_inactive_webhook_on_public_host() {
        let config = BrokerConfig::in_memory(Some([7u8; 32]), "https://box.tail123.ts.net/host");
        let manifest = build_manifest(
            &config,
            "OpenSesame tailnet",
            "https://box.tail123.ts.net/host/api/v1/oauth/github-app/callback",
            "https://pages.example/OpenSesame/settings?github_app=installed",
        );
        assert_eq!(
            manifest["hook_attributes"]["url"],
            "https://box.tail123.ts.net/host/api/v1/webhooks/github"
        );
        assert_eq!(manifest["hook_attributes"]["active"], false);
        assert_eq!(manifest["url"], "https://box.tail123.ts.net/host");
    }

    #[test]
    fn detects_github_app_client_ids() {
        assert!(is_github_app_client_id("Iv1.abc"));
        assert!(is_github_app_client_id("Iv23liSqEoeYvVqc1vfZ"));
        assert!(!is_github_app_client_id("Ov23xxxxxxxx"));
        assert!(!is_github_app_client_id(""));
    }
}
