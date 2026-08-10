//! The token set and its refresh rules.
//!
//! `TokenSet` is the only structure in the crate holding credential material. It
//! is sealed before it reaches storage and never crosses the API boundary
//! (ADR 0032 §6), which is why its `Debug` says nothing.

use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};

use crate::catalog::Provider;
use crate::config::BrokerConfig;
use crate::error::{BrokerError, Result};
use crate::flow;

/// Refresh this far ahead of expiry so an in-flight call does not race the clock.
pub const REFRESH_SKEW_SECONDS: i64 = 60;

#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct TokenSet {
    pub access_token: String,
    pub refresh_token: Option<String>,
    pub token_type: String,
    pub expires_at: Option<DateTime<Utc>>,
    pub scopes: Vec<String>,
}

impl std::fmt::Debug for TokenSet {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TokenSet")
            .field("token_type", &self.token_type)
            .field("expires_at", &self.expires_at)
            .field("refreshable", &self.refresh_token.is_some())
            .field("scopes", &self.scopes)
            .finish_non_exhaustive()
    }
}

impl TokenSet {
    pub fn refreshable(&self) -> bool {
        self.refresh_token.is_some()
    }

    pub fn expired(&self, now: DateTime<Utc>) -> bool {
        self.expires_at.is_some_and(|e| now >= e)
    }

    pub fn needs_refresh(&self, now: DateTime<Utc>) -> bool {
        match self.expires_at {
            Some(expiry) => now + Duration::seconds(REFRESH_SKEW_SECONDS) >= expiry,
            None => false,
        }
    }
}

/// A token endpoint response, in the shape RFC 6749 §5.1 describes.
#[derive(Clone, Debug, Deserialize)]
pub struct TokenResponse {
    pub access_token: String,
    #[serde(default)]
    pub refresh_token: Option<String>,
    #[serde(default)]
    pub token_type: Option<String>,
    #[serde(default)]
    pub expires_in: Option<i64>,
    #[serde(default)]
    pub scope: Option<String>,
    /// Present from OIDC providers. Used only to label the connection on screen.
    #[serde(default)]
    pub id_token: Option<String>,
}

impl TokenResponse {
    /// Who this connection is acting as, for display beside the connection.
    ///
    /// The claim is read without verifying the signature, which is safe only
    /// because of what it is used for: this token came back over TLS from the
    /// provider's own token endpoint in direct response to our request, and the
    /// value decides nothing but a line of text. No authorization consults it.
    pub fn account_label(&self) -> Option<String> {
        let payload = self.id_token.as_deref()?.split('.').nth(1)?;
        let bytes =
            base64::Engine::decode(&base64::engine::general_purpose::URL_SAFE_NO_PAD, payload)
                .ok()?;
        let claims: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
        // Filtering inside the search, so a claim present but blank falls
        // through to the next rather than ending it.
        ["email", "preferred_username", "name", "sub"]
            .iter()
            .find_map(|claim| {
                claims
                    .get(*claim)
                    .and_then(|v| v.as_str())
                    .map(str::trim)
                    .filter(|label| !label.is_empty())
            })
            .map(str::to_string)
    }
}

impl TokenResponse {
    pub fn into_token_set(self, now: DateTime<Utc>, requested_scopes: &[String]) -> TokenSet {
        let scopes = match self.scope.as_deref() {
            Some(s) if !s.trim().is_empty() => split_scopes(s),
            _ => requested_scopes.to_vec(),
        };
        TokenSet {
            access_token: self.access_token,
            refresh_token: self.refresh_token,
            token_type: self.token_type.unwrap_or_else(|| "Bearer".into()),
            expires_at: self.expires_in.map(|s| now + Duration::seconds(s)),
            scopes,
        }
    }
}

/// Scopes come back space-delimited per RFC 6749; some providers use commas.
pub fn split_scopes(raw: &str) -> Vec<String> {
    raw.split([' ', ','])
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .collect()
}

/// Rotation: a returned refresh token replaces its predecessor, and its absence
/// retains the one we hold. Dropping a still-valid refresh token because the
/// provider did not repeat it would strand the connection.
pub fn apply_refresh(previous: &TokenSet, response: TokenResponse, now: DateTime<Utc>) -> TokenSet {
    let mut next = response.into_token_set(now, &previous.scopes);
    if next.refresh_token.is_none() {
        next.refresh_token = previous.refresh_token.clone();
    }
    next
}

pub async fn refresh(
    http: &reqwest::Client,
    provider: &Provider,
    config: &BrokerConfig,
    previous: &TokenSet,
) -> Result<TokenSet> {
    let Some(refresh_token) = previous.refresh_token.clone() else {
        return Err(BrokerError::NotRefreshable);
    };
    let form = vec![
        ("grant_type".to_string(), "refresh_token".to_string()),
        ("refresh_token".to_string(), refresh_token),
    ];
    // A refused refresh is not a transport failure: the grant is gone, and the
    // connection must go to needs_reauth rather than be retried forever.
    let response = flow::post_token_endpoint(http, provider, config, form)
        .await
        .map_err(|e| match e {
            BrokerError::ExchangeFailed(detail) => BrokerError::NeedsReauth(detail),
            other => other,
        })?;
    Ok(apply_refresh(previous, response, Utc::now()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn base() -> TokenSet {
        TokenSet {
            access_token: "old-access".into(),
            refresh_token: Some("old-refresh".into()),
            token_type: "Bearer".into(),
            expires_at: Some(Utc::now() + Duration::hours(1)),
            scopes: vec!["read".into()],
        }
    }

    #[test]
    fn refresh_rotation_replaces_the_old_token() {
        let previous = base();
        let response = TokenResponse {
            access_token: "new-access".into(),
            refresh_token: Some("new-refresh".into()),
            token_type: Some("Bearer".into()),
            expires_in: Some(3600),
            scope: Some("read write".into()),
            id_token: None,
        };
        let next = apply_refresh(&previous, response, Utc::now());
        assert_eq!(next.access_token, "new-access");
        assert_eq!(next.refresh_token.as_deref(), Some("new-refresh"));
        assert_eq!(next.scopes, vec!["read".to_string(), "write".to_string()]);
    }

    #[test]
    fn a_provider_that_omits_a_refresh_token_keeps_ours() {
        let previous = base();
        let response = TokenResponse {
            access_token: "new-access".into(),
            refresh_token: None,
            token_type: None,
            expires_in: Some(60),
            scope: None,
            id_token: None,
        };
        let next = apply_refresh(&previous, response, Utc::now());
        assert_eq!(next.refresh_token.as_deref(), Some("old-refresh"));
        assert_eq!(next.token_type, "Bearer");
        assert_eq!(next.scopes, previous.scopes);
    }

    #[test]
    fn refresh_happens_inside_the_skew_window() {
        let now = Utc::now();
        let mut t = base();
        t.expires_at = Some(now + Duration::seconds(REFRESH_SKEW_SECONDS - 1));
        assert!(t.needs_refresh(now));
        assert!(!t.expired(now));

        t.expires_at = Some(now + Duration::seconds(REFRESH_SKEW_SECONDS + 5));
        assert!(!t.needs_refresh(now));

        t.expires_at = None;
        assert!(!t.needs_refresh(now));
        assert!(!t.expired(now));
    }

    #[test]
    fn tokens_are_not_printable() {
        let rendered = format!("{:?}", base());
        assert!(!rendered.contains("old-access"));
        assert!(!rendered.contains("old-refresh"));
        assert!(rendered.contains("refreshable"));
    }

    /// Builds an unsigned JWT: the label reader never checks the signature, and
    /// the test should not imply otherwise by producing a real one.
    fn id_token_with(claims: serde_json::Value) -> String {
        use base64::Engine as _;
        let body = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .encode(serde_json::to_vec(&claims).unwrap());
        format!("header.{body}.signature")
    }

    #[test]
    fn account_label_prefers_the_most_recognisable_claim() {
        let response = |claims| TokenResponse {
            access_token: "a".into(),
            refresh_token: None,
            token_type: None,
            expires_in: None,
            scope: None,
            id_token: Some(id_token_with(claims)),
        };

        assert_eq!(
            response(serde_json::json!({"sub": "u1", "name": "Ada", "email": "ada@example.com"}))
                .account_label()
                .as_deref(),
            Some("ada@example.com")
        );
        assert_eq!(
            response(serde_json::json!({"sub": "u1", "name": "Ada"}))
                .account_label()
                .as_deref(),
            Some("Ada")
        );
        assert_eq!(
            response(serde_json::json!({"sub": "u1"}))
                .account_label()
                .as_deref(),
            Some("u1")
        );
        // A blank claim is not a name; fall through rather than label it "".
        assert_eq!(
            response(serde_json::json!({"email": "  ", "sub": "u1"}))
                .account_label()
                .as_deref(),
            Some("u1")
        );
    }

    #[test]
    fn a_provider_without_an_id_token_is_simply_unlabelled() {
        let mut response = TokenResponse {
            access_token: "a".into(),
            refresh_token: None,
            token_type: None,
            expires_in: None,
            scope: None,
            id_token: None,
        };
        assert_eq!(response.account_label(), None);

        // Garbage must not panic its way out of a successful authorization.
        response.id_token = Some("not-a-jwt".into());
        assert_eq!(response.account_label(), None);
        response.id_token = Some("a.!!!not-base64!!!.c".into());
        assert_eq!(response.account_label(), None);
    }

    #[test]
    fn scopes_fall_back_to_what_was_requested() {
        let response = TokenResponse {
            access_token: "a".into(),
            refresh_token: None,
            token_type: None,
            expires_in: None,
            scope: Some("   ".into()),
            id_token: None,
        };
        let set = response.into_token_set(Utc::now(), &["read".to_string()]);
        assert_eq!(set.scopes, vec!["read".to_string()]);
        assert!(set.expires_at.is_none());
        assert!(!set.refreshable());
    }
}
