//! Thin Host → Identity HTTP client for principal mapping resolve.
//!
//! Resolves issuer+subject → canonical principal_id only. There is intentionally
//! **no** email lookup method — email auto-link is forbidden (ADR 0042).

use serde::Deserialize;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum MappingClientError {
    #[error("identity mapping HTTP error: {0}")]
    Http(String),
    #[error("identity mapping rejected email join")]
    EmailJoinForbidden,
    #[error("identity mapping unauthorized")]
    Unauthorized,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MappedPrincipal {
    pub principal_id: String,
    #[serde(default)]
    pub provisional: bool,
    #[serde(default)]
    pub assurance: String,
    #[serde(default)]
    pub issuer: String,
    #[serde(default)]
    pub subject: String,
}

/// Service client for `GET /v1/principals/mapping/resolve`.
#[derive(Clone)]
pub struct IdentityMappingClient {
    base_url: String,
    token: String,
    http: reqwest::Client,
}

impl IdentityMappingClient {
    pub fn from_env() -> Self {
        let base_url = std::env::var("OPENSESAME_API_URL")
            .or_else(|_| std::env::var("OPENSESAME_IDENTITY_URL"))
            .unwrap_or_else(|_| "http://127.0.0.1:8788".into())
            .trim_end_matches('/')
            .to_string();
        let token = std::env::var("OPENSESAME_MAPPING_RESOLVE_TOKEN")
            .or_else(|_| std::env::var("OPENSESAME_NATS_CALLOUT_SECRET"))
            .unwrap_or_default();
        Self::new(base_url, token)
    }

    pub fn new(base_url: impl Into<String>, token: impl Into<String>) -> Self {
        Self {
            base_url: base_url.into().trim_end_matches('/').to_string(),
            token: token.into(),
            http: reqwest::Client::new(),
        }
    }

    /// Resolve by upstream issuer + subject. Never joins by email.
    pub async fn resolve_upstream(
        &self,
        issuer: &str,
        subject: &str,
    ) -> Result<Option<MappedPrincipal>, MappingClientError> {
        let url = format!(
            "{}/v1/principals/mapping/resolve?issuer={}&subject={}",
            self.base_url,
            urlencoding_encode(issuer),
            urlencoding_encode(subject)
        );
        let mut req = self.http.get(&url);
        if !self.token.is_empty() {
            req = req.bearer_auth(&self.token);
        }
        let resp = req
            .send()
            .await
            .map_err(|e| MappingClientError::Http(e.to_string()))?;
        match resp.status().as_u16() {
            200 => {
                let body = resp
                    .json::<MappedPrincipal>()
                    .await
                    .map_err(|e| MappingClientError::Http(e.to_string()))?;
                Ok(Some(body))
            }
            404 => Ok(None),
            400 => {
                let err_body: serde_json::Value = resp.json().await.unwrap_or_default();
                if err_body.get("error").and_then(|v| v.as_str()) == Some("email_join_forbidden")
                {
                    Err(MappingClientError::EmailJoinForbidden)
                } else {
                    Err(MappingClientError::Http(err_body.to_string()))
                }
            }
            401 | 403 => Err(MappingClientError::Unauthorized),
            code => {
                let text = resp.text().await.unwrap_or_default();
                Err(MappingClientError::Http(format!("status {code}: {text}")))
            }
        }
    }
}

/// Minimal query encoding without pulling in an extra crate.
fn urlencoding_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char);
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// In-memory mapper used by callout unit tests (no Identity HTTP).
#[derive(Clone, Default)]
pub struct MemoryPrincipalMapper {
    /// key: "issuer\\0subject"
    entries: std::sync::Arc<std::sync::Mutex<std::collections::HashMap<String, MappedPrincipal>>>,
}

impl MemoryPrincipalMapper {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn insert(&self, issuer: &str, subject: &str, mapped: MappedPrincipal) {
        let key = format!("{issuer}\0{subject}");
        self.entries.lock().unwrap().insert(key, mapped);
    }

    pub fn resolve_upstream(&self, issuer: &str, subject: &str) -> Option<MappedPrincipal> {
        let key = format!("{issuer}\0{subject}");
        self.entries.lock().unwrap().get(&key).cloned()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn memory_mapper_resolves_issuer_subject_only() {
        let m = MemoryPrincipalMapper::new();
        m.insert(
            "https://idp.example",
            "sub-1",
            MappedPrincipal {
                principal_id: "prn_1".into(),
                provisional: false,
                assurance: "verified".into(),
                issuer: "https://idp.example".into(),
                subject: "sub-1".into(),
            },
        );
        assert_eq!(
            m.resolve_upstream("https://idp.example", "sub-1")
                .unwrap()
                .principal_id,
            "prn_1"
        );
        assert!(m.resolve_upstream("https://idp.example", "other").is_none());
    }

    #[test]
    fn urlencoding_encodes_reserved() {
        assert_eq!(urlencoding_encode("a/b"), "a%2Fb");
        assert_eq!(urlencoding_encode("https://x"), "https%3A%2F%2Fx");
    }
}
