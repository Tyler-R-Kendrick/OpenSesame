//! The one road to Tailscale (ADR 0166 §2).
//!
//! Device and key calls go through invoke-through with a one-row allowlist,
//! `https://api.tailscale.com` exactly: no redirect is followed, the token is
//! placed in one sensitive header and zeroized with the request, bodies are
//! capped both ways, and an echoed credential is scrubbed. An OAuth client is
//! traded for an access token by one fixed POST to `/api/v2/oauth/token` on
//! the same host, redirects off; the token lives in memory until a minute
//! before it expires, and a 401 drops it and tries once more with a fresh one.

use std::time::{Duration, Instant};

use bytes::Bytes;
use opensesame_invoke_through::{
    AuthStyle, EgressRule, InvokeError, InvokeRequest, Invoker, DEFAULT_REQUEST_BODY_CAP,
};
use secrecy::{ExposeSecret as _, SecretString};
use serde_json::Value;

use crate::config::{AdminStore, CredentialKind, TailnetConfig};
use crate::error::safe_message;
use crate::{wire, AdminError};

/// Tailscale's API host, exactly.
pub const API_HOST: &str = "api.tailscale.com";
/// Its base URL.
pub const API_BASE: &str = "https://api.tailscale.com";
/// The allowlist row, restated from `spec/connectors/catalog.json` (a drift
/// test reads the file).
pub const EGRESS_RULE: EgressRule = EgressRule {
    provider_id: "tailscale",
    scheme: "https",
    hosts: &[API_HOST],
    auth: AuthStyle::Bearer,
};
/// Names a loopback stub instead of api.tailscale.com, in an
/// `upstream-override` build only.
#[cfg(feature = "upstream-override")]
pub const API_BASE_ENV: &str = "OPENSESAME_TAILSCALE_API_BASE";

/// The largest answer read from Tailscale: `devices?fields=all` costs a few
/// KiB a machine, so the broker's 1 MiB default would refuse a tailnet of a
/// few hundred. 32 MiB holds about ten thousand.
const RESPONSE_BODY_CAP: usize = 32 * 1024 * 1024;

const MINT_TIMEOUT: Duration = Duration::from_secs(15);
const MINT_BODY_CAP: u64 = 64 * 1024;
const EARLY_EXPIRY: Duration = Duration::from_secs(60);

struct Cached {
    client_id: String,
    token: SecretString,
    until: Instant,
}

/// Calls Tailscale on the connected tailnet's behalf.
pub struct Upstream {
    base: String,
    invoker: Invoker,
    mint: reqwest::Client,
    cached: tokio::sync::Mutex<Option<Cached>>,
}

impl std::fmt::Debug for Upstream {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Upstream")
            .field("base", &self.base)
            .finish_non_exhaustive()
    }
}

fn mint_client(https_only: bool) -> reqwest::Client {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .https_only(https_only)
        .timeout(MINT_TIMEOUT)
        .build()
        .unwrap_or_default()
}

impl Default for Upstream {
    fn default() -> Self {
        Self::production()
    }
}

impl Upstream {
    /// api.tailscale.com, https, the allowlist above.
    #[must_use]
    pub fn production() -> Self {
        Self {
            base: API_BASE.to_string(),
            invoker: Invoker::with_rules(vec![EGRESS_RULE])
                .with_caps(DEFAULT_REQUEST_BODY_CAP, RESPONSE_BODY_CAP),
            mint: mint_client(true),
            cached: tokio::sync::Mutex::new(None),
        }
    }

    /// A stub on this machine, over plain http. Tests and the end-to-end
    /// harness only; `None` for anything but a loopback http base.
    #[cfg(any(test, feature = "upstream-override"))]
    #[must_use]
    pub fn loopback(base: &str) -> Option<Self> {
        let rest = base.trim_end_matches('/').strip_prefix("http://")?;
        let host = rest.rsplit_once(':').map_or(rest, |(host, _)| host);
        if !matches!(host, "127.0.0.1" | "localhost") {
            return None;
        }
        let host: &'static str = Box::leak(host.to_string().into_boxed_str());
        let hosts: &'static [&'static str] = Box::leak(vec![host].into_boxed_slice());
        let rule = EgressRule {
            hosts,
            ..EGRESS_RULE
        };
        Some(Self {
            base: base.trim_end_matches('/').to_string(),
            invoker: Invoker::with_rules(vec![rule])
                .with_caps(DEFAULT_REQUEST_BODY_CAP, RESPONSE_BODY_CAP)
                .allow_http_for_tests(),
            mint: mint_client(false),
            cached: tokio::sync::Mutex::new(None),
        })
    }

    /// [`Self::production`], or the stub [`API_BASE_ENV`] names — only in a
    /// debug build with the feature. Cargo unifies features across a
    /// workspace build, so the daemon's test dependency can switch the
    /// feature on for a binary built in the same run; a release build still
    /// never reads the variable.
    #[cfg(all(feature = "upstream-override", debug_assertions))]
    #[must_use]
    pub fn from_env() -> Self {
        std::env::var(API_BASE_ENV)
            .ok()
            .and_then(|base| Self::loopback(&base))
            .unwrap_or_else(Self::production)
    }

    /// [`Self::production`]: a shipped build reads no base from anywhere.
    #[cfg(not(all(feature = "upstream-override", debug_assertions)))]
    #[must_use]
    pub fn from_env() -> Self {
        Self::production()
    }

    async fn mint(&self, client_id: &str, secret: &SecretString) -> Result<Cached, AdminError> {
        let form = [
            ("client_id", client_id),
            ("client_secret", secret.expose_secret()),
            ("grant_type", "client_credentials"),
        ];
        let response = self
            .mint
            .post(format!("{}/api/v2/oauth/token", self.base))
            .form(&form)
            .send()
            .await
            .map_err(|_| AdminError::Unavailable("token request failed".into()))?;
        let status = response.status().as_u16();
        if matches!(status, 400 | 401 | 403) {
            return Err(AdminError::CredentialRefused { status });
        }
        if !response.status().is_success()
            || response
                .content_length()
                .is_some_and(|len| len > MINT_BODY_CAP)
        {
            return Err(AdminError::Unavailable(format!("token answered {status}")));
        }
        let body: Value = response
            .json()
            .await
            .map_err(|_| AdminError::Unavailable("token answer unreadable".into()))?;
        let token = body
            .get("access_token")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let printable = token.bytes().all(|b| b.is_ascii_graphic());
        if token.is_empty() || token.len() > 512 || !printable {
            return Err(AdminError::Unavailable("token answer unreadable".into()));
        }
        let lifetime = body
            .get("expires_in")
            .and_then(Value::as_u64)
            .unwrap_or(3600);
        let until = Instant::now() + Duration::from_secs(lifetime).saturating_sub(EARLY_EXPIRY);
        Ok(Cached {
            client_id: client_id.to_string(),
            token: SecretString::from(token.to_string()),
            until,
        })
    }

    async fn token(
        &self,
        store: &AdminStore,
        config: &TailnetConfig,
    ) -> Result<SecretString, AdminError> {
        let kind = config.credential.kind;
        if kind == CredentialKind::ApiKey {
            return store.secret(kind);
        }
        let client_id = &config.credential.client_id;
        let mut cached = self.cached.lock().await;
        if let Some(hit) = cached
            .as_ref()
            .filter(|c| &c.client_id == client_id && c.until > Instant::now())
        {
            return Ok(hit.token.clone());
        }
        let fresh = self.mint(client_id, &store.secret(kind)?).await?;
        let token = fresh.token.clone();
        *cached = Some(fresh);
        Ok(token)
    }

    async fn forget_token(&self) {
        *self.cached.lock().await = None;
    }

    async fn send(
        &self,
        token: &SecretString,
        method: &str,
        url: &str,
        body: Option<&Value>,
    ) -> Result<(u16, Option<u64>, Bytes), AdminError> {
        let mut headers = vec![("accept".to_string(), "application/json".to_string())];
        let body = body.map(|b| Bytes::from(b.to_string()));
        if body.is_some() {
            headers.push(("content-type".into(), "application/json".into()));
        }
        let prepared = self
            .invoker
            .preflight(InvokeRequest {
                provider_id: EGRESS_RULE.provider_id.into(),
                method: method.into(),
                url: url.into(),
                headers,
                body,
                subject: None,
                actor: None,
            })
            .map_err(|error| AdminError::Unavailable(fence_class(&error)))?;
        let response = self
            .invoker
            .execute(token, prepared)
            .await
            .map_err(|error| AdminError::Unavailable(fence_class(&error)))?;
        let retry = response
            .headers
            .iter()
            .find(|(name, _)| name.eq_ignore_ascii_case("retry-after"))
            .and_then(|(_, value)| value.trim().parse().ok());
        Ok((response.status, retry, response.body))
    }

    /// Call `method path` (under `/api/v2`) on the connected tailnet's
    /// behalf. `Value::Null` for an empty success.
    ///
    /// # Errors
    ///
    /// `NotConnected`, or how Tailscale answered (see [`AdminError`]).
    pub async fn call(
        &self,
        store: &AdminStore,
        method: &str,
        path: &str,
        body: Option<&Value>,
    ) -> Result<Value, AdminError> {
        let config = store.config()?.ok_or(AdminError::NotConnected)?;
        let url = format!("{}/api/v2{path}", self.base);
        let mut token = self.token(store, &config).await?;
        let mut answer = self.send(&token, method, &url, body).await?;
        if answer.0 == 401 && config.credential.kind == CredentialKind::Oauth {
            self.forget_token().await;
            token = self.token(store, &config).await?;
            answer = self.send(&token, method, &url, body).await?;
        }
        let (status, retry_after, bytes) = answer;
        let json: Value = if bytes.is_empty() {
            Value::Null
        } else {
            serde_json::from_slice(&bytes).unwrap_or(Value::Null)
        };
        match status {
            200..=299 => Ok(json),
            401 | 403 => Err(AdminError::CredentialRefused { status }),
            404 => Err(AdminError::NotFound),
            429 => Err(AdminError::RateLimited {
                retry_after: retry_after.unwrap_or(30),
            }),
            400..=499 => Err(AdminError::Rejected {
                message: safe_message(&wire::error_message(&json)),
            }),
            _ => Err(AdminError::Unavailable(format!(
                "Tailscale answered {status}"
            ))),
        }
    }
}

/// A failure class for an error message: never a URL, never a body.
fn fence_class(error: &InvokeError) -> String {
    match error {
        InvokeError::Timeout => "timed out".into(),
        InvokeError::ResponseTooLarge { .. } => "answer too large".into(),
        InvokeError::Transport(_) => "unreachable".into(),
        _ => "refused by the egress fence".into(),
    }
}

#[cfg(test)]
#[path = "upstream_tests.rs"]
mod tests;
