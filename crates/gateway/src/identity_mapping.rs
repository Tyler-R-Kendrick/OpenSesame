//! Thin Host → Identity HTTP client for principal mapping resolve.
//!
//! Resolves issuer+subject → canonical `principal_id` only. There is intentionally
//! **no** email lookup method — email auto-link is forbidden (ADR 0042).

use std::{net::IpAddr, time::Duration};

use serde::Deserialize;
use thiserror::Error;

use crate::identity_mapping_tls::MappingAuth;

#[cfg(test)]
#[path = "identity_mapping_tests.rs"]
mod transport_tests;

#[derive(Debug, Error)]
pub enum MappingClientError {
    #[error("identity mapping HTTP error: {0}")]
    Http(String),
    #[error("identity mapping unauthorized")]
    Unauthorized,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MappedPrincipal {
    pub principal_id: String,
    pub provisional: bool,
    pub assurance: String,
    pub issuer: String,
    pub subject: String,
}

/// Service client for `GET /v1/principals/mapping/resolve`.
#[derive(Clone)]
pub struct IdentityMappingClient {
    endpoint: url::Url,
    auth: MappingAuth,
    allow_private: bool,
}

/// Never prints a credential: the endpoint and the *mode*, nothing else.
impl std::fmt::Debug for IdentityMappingClient {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("IdentityMappingClient")
            .field("endpoint", &self.endpoint.as_str())
            .field("auth", &self.auth)
            .finish_non_exhaustive()
    }
}

impl IdentityMappingClient {
    /// The startup predicate (SVC-STARTUP). Exactly one authentication mode
    /// is honoured; a certificate-only deployment never needs the bearer
    /// secret, and a missing configured certificate is a startup error rather
    /// than a silent downgrade to "legacy auth".
    ///
    /// # Errors
    /// The configured mode's own material failure, or an endpoint outside
    /// the deployment policy.
    pub fn from_startup(
        deployment: opensesame_host_core::deployment_mode::Deployment,
        mode: crate::transport::config::AuthMode,
    ) -> Result<Option<Self>, String> {
        let lookup = |name: &str| std::env::var(name).ok().filter(|v| !v.trim().is_empty());
        let Some(auth) = crate::identity_mapping_tls::resolve(mode, &lookup)? else {
            return Ok(None);
        };
        let identity = &opensesame_host_core::endpoints::endpoint("identity").address;
        let base_url = identity
            .names()
            .find_map(lookup)
            .ok_or_else(|| "mapping endpoint is required".to_owned())?;
        let private = lookup("OPENSESAME_MAPPING_PRIVATE_ENDPOINT");
        Self::configured(
            &base_url,
            auth,
            !deployment.production_safeguards(),
            private.as_deref(),
        )
        .map(Some)
        .map_err(|e| e.to_string())
    }

    /// An mTLS-mode client for an explicit endpoint and profile. The server
    /// name the profile expects must be the endpoint's host: a mismatch is
    /// refused here, before any connection is attempted.
    ///
    /// # Errors
    /// As [`Self::configured`], plus `mapping server name mismatch`.
    #[cfg(test)]
    pub fn with_mtls(
        base_url: &str,
        profile: opensesame_transport_security::ClientProfile,
        local: bool,
    ) -> Result<Self, MappingClientError> {
        Self::configured(base_url, MappingAuth::Mtls(Box::new(profile)), local, None)
    }

    #[cfg(test)]
    /// # Errors
    /// Refuses endpoints or credentials outside the networked policy.
    pub fn new(
        base_url: impl AsRef<str>,
        token: impl Into<String>,
    ) -> Result<Self, MappingClientError> {
        Self::configured(
            base_url.as_ref(),
            MappingAuth::bearer(token.into())?,
            false,
            None,
        )
    }

    fn configured(
        base: &str,
        auth: MappingAuth,
        local: bool,
        private: Option<&str>,
    ) -> Result<Self, MappingClientError> {
        let mut endpoint =
            url::Url::parse(base).map_err(|_| refused("invalid mapping endpoint"))?;
        let loopback = endpoint.host_str().is_some_and(|h| {
            h == "localhost"
                || h.trim_matches(['[', ']'])
                    .parse::<IpAddr>()
                    .is_ok_and(|ip| ip.is_loopback())
        });
        if base.bytes().any(|b| b.is_ascii_whitespace() || b == b'\\')
            || base.len() > 2048
            || (base != endpoint.origin().ascii_serialization() && base != endpoint.as_str())
            || !endpoint.username().is_empty()
            || endpoint.password().is_some()
            || endpoint.query().is_some()
            || endpoint.fragment().is_some()
            || endpoint.path() != "/"
            || endpoint.host_str().is_none_or(|h| h.ends_with('.'))
            || !(endpoint.scheme() == "https"
                || (local && loopback && !auth.is_mtls() && endpoint.scheme() == "http"))
        {
            return Err(refused("invalid mapping endpoint"));
        }
        // Under `mtls` the expected server identity and the endpoint host are
        // the same name or the configuration is a mistake; refusing here means
        // a wrong server name never reaches a socket.
        if auth
            .expected_server_name()
            .is_some_and(|name| Some(name) != endpoint.host_str())
        {
            return Err(refused("mapping server name mismatch"));
        }
        let allow_private = (local && loopback) || private == Some(endpoint.as_str());
        if !allow_private
            && opensesame_connector_host::is_blocked_host(endpoint.host_str().unwrap_or_default())
        {
            return Err(refused("mapping destination refused"));
        }
        endpoint.set_path("/v1/principals/mapping/resolve");
        Ok(Self {
            endpoint,
            auth,
            allow_private,
        })
    }

    /// Resolve by upstream issuer + subject. Never joins by email.
    ///
    /// # Errors
    /// Refuses transport policy failures, unbounded responses, or identity mismatch.
    pub async fn resolve_upstream(
        &self,
        issuer: &str,
        subject: &str,
    ) -> Result<Option<MappedPrincipal>, MappingClientError> {
        if issuer.is_empty() || subject.is_empty() || issuer.len() > 2048 || subject.len() > 1024 {
            return Err(refused("invalid mapping request"));
        }
        let mut url = self.endpoint.clone();
        url.query_pairs_mut()
            .append_pair("issuer", issuer)
            .append_pair("subject", subject);
        let host = self
            .endpoint
            .host_str()
            .ok_or_else(|| refused("invalid mapping endpoint"))?
            .trim_matches(['[', ']']);
        let port = self
            .endpoint
            .port_or_known_default()
            .ok_or_else(|| refused("invalid mapping endpoint"))?;
        let addresses: Vec<_> = tokio::time::timeout(
            Duration::from_secs(2),
            tokio::net::lookup_host((host, port)),
        )
        .await
        .map_err(|_| refused("mapping resolution timeout"))?
        .map_err(|_| refused("mapping resolution failed"))?
        .take(17)
        .collect();
        if addresses.is_empty()
            || addresses.len() > 16
            || (self.endpoint.scheme() == "http" && addresses.iter().any(|a| !a.ip().is_loopback()))
            || (!self.allow_private
                && addresses
                    .iter()
                    .any(|a| opensesame_connector_host::is_blocked_host(&a.ip().to_string())))
        {
            return Err(refused("mapping destination refused"));
        }
        let base = reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(2))
            .timeout(Duration::from_secs(5))
            .resolve_to_addrs(host, &addresses);
        let http = self
            .auth
            .apply_builder(base)?
            .build()
            .map_err(|_| refused("mapping transport unavailable"))?;
        let resp = self
            .auth
            .apply_request(http.get(url))
            .send()
            .await
            .map_err(|_| refused("mapping request failed"))?;
        match resp.status().as_u16() {
            200 => {
                let body = read_response(resp).await?;
                validate_mapping(&body, issuer, subject)?;
                Ok(Some(body))
            }
            404 => Ok(None),
            400 => Err(refused("mapping request rejected")),
            401 | 403 => Err(MappingClientError::Unauthorized),
            _ => Err(refused("mapping service refused request")),
        }
    }
}

fn refused(code: &'static str) -> MappingClientError {
    MappingClientError::Http(code.into())
}

async fn read_response(mut resp: reqwest::Response) -> Result<MappedPrincipal, MappingClientError> {
    if resp.content_length().is_some_and(|length| length > 8192) {
        return Err(refused("mapping response too large"));
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = resp
        .chunk()
        .await
        .map_err(|_| refused("mapping response failed"))?
    {
        if chunk.len() > 8192 - bytes.len() {
            return Err(refused("mapping response too large"));
        }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes).map_err(|_| refused("invalid mapping response"))
}

fn validate_mapping(
    body: &MappedPrincipal,
    issuer: &str,
    subject: &str,
) -> Result<(), MappingClientError> {
    if body.issuer != issuer
        || body.subject != subject
        || !valid_principal(&body.principal_id)
        || !matches!(
            body.assurance.as_str(),
            "provisional"
                | "self_asserted"
                | "verified"
                | "mfa"
                | "phishing_resistant"
                | "enterprise_managed"
                | "workload_attested"
        )
        || body.provisional != (body.assurance == "provisional")
    {
        return Err(refused("mapping identity mismatch"));
    }
    Ok(())
}

fn valid_principal(value: &str) -> bool {
    // Identity's canonical generator is prn_<32 lowercase hex>; Host uses typed UUID IDs.
    opensesame_domain::PrincipalId::parse(value.strip_prefix("prn_").unwrap_or(value))
        .is_ok_and(|id| !id.as_uuid().is_nil())
}

/// In-memory mapper used by callout unit tests (no Identity HTTP).
#[cfg(test)]
#[derive(Clone, Default)]
pub struct MemoryPrincipalMapper {
    /// key: "issuer\\0subject"
    entries: std::sync::Arc<std::sync::Mutex<std::collections::HashMap<String, MappedPrincipal>>>,
}

#[cfg(test)]
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
    fn endpoint_policy_rejects_credential_disclosure() {
        for endpoint in [
            "http://identity.example",
            "https://user:secret@identity.example",
            "https://identity.example/path",
            "https://identity.example?key=x",
            "https://identity.example#x",
            "https://127.0.0.1",
            "https://identity.example.",
        ] {
            assert!(IdentityMappingClient::new(endpoint, "a".repeat(32)).is_err());
        }
        assert!(IdentityMappingClient::new("https://identity.example", "a".repeat(32)).is_ok());
    }
}
