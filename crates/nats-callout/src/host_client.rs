//! The Host decision contract (`POST /api/v1/nats/auth/callout`) and the
//! bridge's mTLS client for it.
//!
//! The body carries the verified request's facts *and* the raw request JWT,
//! so the Host re-verifies signature, window, audience, user key and digest
//! for itself; the bridge's word is worth exactly one fact (see the crate
//! docs). The response must echo `request_digest`, `user_nkey` and
//! `server_id` — [`check_echo`] refuses to sign anything that does not.

use std::time::Duration;

use opensesame_authz::CalloutPermissions;
use serde::{Deserialize, Serialize};

use crate::digest::RequestDigest;
use crate::error::CalloutError;
use crate::evidence::{extract, ExtractedEvidence};
use crate::jwt::VerifiedRequest;

/// Bytes of a Host response the bridge will read.
pub const MAX_RESPONSE_BYTES: usize = 64 * 1024;

/// `server` in the decision request.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ServerRef {
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub cluster: String,
}

/// `client` in the decision request: non-secret CONNECT facts.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ClientRef {
    #[serde(default)]
    pub kind: String,
    #[serde(default, rename = "type")]
    pub client_type: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub host: String,
}

/// End-user evidence as the Host receives it.
pub type HostEvidence = ExtractedEvidence;

/// What the bridge asks the Host.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HostDecisionRequest {
    pub request_digest: String,
    pub server: ServerRef,
    pub user_nkey: String,
    pub request_nonce: String,
    pub client: ClientRef,
    #[serde(default)]
    pub evidence: Option<HostEvidence>,
    /// The server-signed request, for independent re-verification.
    pub raw_request_jwt: String,
}

impl HostDecisionRequest {
    /// Build from a verified request.
    #[must_use]
    pub fn from_verified(verified: &VerifiedRequest) -> Self {
        let claims = &verified.claims;
        let evidence = extract(claims);
        Self {
            request_digest: RequestDigest::compute(claims).to_string(),
            server: ServerRef {
                id: claims.nats.server_id.id.clone(),
                name: claims.nats.server_id.name.clone(),
                cluster: claims.nats.server_id.cluster.clone(),
            },
            user_nkey: claims.nats.user_nkey.clone(),
            request_nonce: claims.nats.request_nonce.clone(),
            client: ClientRef {
                kind: claims.nats.client_info.kind.clone(),
                client_type: claims.nats.client_info.client_type.clone(),
                name: claims.nats.client_info.name.clone(),
                host: claims.nats.client_info.host.clone(),
            },
            evidence: (!evidence.is_empty()).then_some(evidence),
            raw_request_jwt: verified.raw().to_owned(),
        }
    }
}

/// What the Host answers.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct HostDecisionResponse {
    pub decision: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub principal_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provisional: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub permissions: Option<CalloutPermissions>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub user_nkey: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub server_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub request_digest: Option<String>,
    /// RFC 3339 expiry of the decision (and of any user JWT issued from it).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exp: Option<String>,
    /// `verified`, or `unverified_dev` when a development-only unsigned path
    /// produced the decision. The bridge never signs an allow for the latter.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub enforcement: Option<String>,
}

/// Refuse a response that does not name the exact request it decided.
///
/// # Errors
///
/// `ResponseMismatch` when the digest, user nkey or server id differ, or an
/// allow lacks permissions / expiry / verified enforcement.
pub fn check_echo(
    req: &HostDecisionRequest,
    resp: &HostDecisionResponse,
) -> Result<(), CalloutError> {
    let same = |echoed: &Option<String>, expected: &str| echoed.as_deref() == Some(expected);
    if !same(&resp.request_digest, &req.request_digest)
        || !same(&resp.user_nkey, &req.user_nkey)
        || !same(&resp.server_id, &req.server.id)
    {
        return Err(CalloutError::ResponseMismatch);
    }
    if resp.decision == "allow"
        && (resp.permissions.is_none()
            || resp.exp.is_none()
            || resp.enforcement.as_deref() != Some("verified"))
    {
        return Err(CalloutError::ResponseMismatch);
    }
    Ok(())
}

/// Where decisions come from. The production implementation is
/// [`HttpHost`]; tests supply canned decisions.
#[async_trait::async_trait]
pub trait DecisionSource: Send + Sync {
    /// Ask for a decision. Any error is a deny.
    async fn decide(&self, req: &HostDecisionRequest)
        -> Result<HostDecisionResponse, CalloutError>;
}

/// The Host over mTLS.
pub struct HttpHost {
    client: reqwest::Client,
    url: url::Url,
}

impl std::fmt::Debug for HttpHost {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("HttpHost")
            .field("url", &self.url.as_str())
            .finish()
    }
}

impl HttpHost {
    /// Build from a TLS profile (server trust + the bridge's identity) and
    /// the Host base URL. No redirects, no proxy, 2 s connect / 5 s total.
    ///
    /// # Errors
    ///
    /// `MalformedConfiguration` for a non-https base URL, a profile without a
    /// client identity, or a client that cannot be built.
    pub fn new(
        profile: &opensesame_transport_security::ClientProfile,
        base: &url::Url,
    ) -> Result<Self, CalloutError> {
        if base.scheme() != "https" || base.host_str().is_none() || base.query().is_some() {
            return Err(crate::error::misconfigured(
                "Host URL must be https with no query",
            ));
        }
        if profile.identity.is_none() {
            return Err(crate::error::misconfigured(
                "the bridge needs a client identity for the Host (OPENSESAME_CALLOUT_TLS_IDENTITY_SOURCE)",
            ));
        }
        let builder = reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(2))
            .timeout(Duration::from_secs(5))
            .http1_only();
        let client = opensesame_transport_security::reqwest_builder(profile, builder)
            .map_err(|e| crate::error::misconfigured(format!("Host client: {}", e.code())))?
            .build()
            .map_err(|e| crate::error::misconfigured(format!("Host client: {e}")))?;
        let mut url = base.clone();
        url.set_path("/api/v1/nats/auth/callout");
        Ok(Self { client, url })
    }
}

#[async_trait::async_trait]
impl DecisionSource for HttpHost {
    async fn decide(
        &self,
        req: &HostDecisionRequest,
    ) -> Result<HostDecisionResponse, CalloutError> {
        let response = self
            .client
            .post(self.url.clone())
            .json(req)
            .send()
            .await
            .map_err(|e| {
                tracing::warn!(
                    timeout = e.is_timeout(),
                    connect = e.is_connect(),
                    "Host callout unreachable"
                );
                CalloutError::HostUnreachable
            })?;
        let status = response.status();
        if status != reqwest::StatusCode::OK {
            tracing::warn!(
                status = status.as_u16(),
                "Host callout refused the decision request"
            );
            return Err(CalloutError::HostError);
        }
        if response
            .content_length()
            .is_some_and(|len| len > MAX_RESPONSE_BYTES as u64)
        {
            return Err(CalloutError::HostError);
        }
        let bytes = response
            .bytes()
            .await
            .map_err(|_| CalloutError::HostError)?;
        if bytes.len() > MAX_RESPONSE_BYTES {
            return Err(CalloutError::HostError);
        }
        serde_json::from_slice(&bytes).map_err(|_| CalloutError::HostError)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fixtures::Parties;
    use crate::jwt::{decode_request, Expectations};

    fn pair() -> (HostDecisionRequest, HostDecisionResponse) {
        let p = Parties::generate();
        let now = 1_800_000_000;
        let token = p.signed_request(now, "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiIxIn0.c2ln");
        let verified = decode_request(
            &token,
            &Expectations {
                server_public_keys: vec![],
                callout_subject: None,
                now,
            },
        )
        .unwrap();
        let req = HostDecisionRequest::from_verified(&verified);
        let resp = HostDecisionResponse {
            decision: "allow".into(),
            permissions: Some(CalloutPermissions {
                publish: vec!["a".into()],
                subscribe: vec!["a".into()],
            }),
            user_nkey: Some(req.user_nkey.clone()),
            server_id: Some(req.server.id.clone()),
            request_digest: Some(req.request_digest.clone()),
            exp: Some("2030-01-01T00:00:00Z".into()),
            enforcement: Some("verified".into()),
            ..HostDecisionResponse::default()
        };
        (req, resp)
    }

    #[test]
    fn request_carries_evidence_and_the_raw_jwt_but_no_password() {
        let (req, _) = pair();
        assert!(req.evidence.as_ref().unwrap().upstream_token.is_some());
        assert!(req.raw_request_jwt.starts_with("eyJ"));
        let wire = serde_json::to_string(&req).unwrap();
        assert!(!wire.contains("\"pass\""));
        assert!(!wire.contains("\"certs\""));
        let back: HostDecisionRequest = serde_json::from_str(&wire).unwrap();
        assert_eq!(back, req);
    }

    #[test]
    fn echo_check_refuses_every_tampered_field() {
        let (req, good) = pair();
        assert!(check_echo(&req, &good).is_ok());
        let mut r = good.clone();
        r.request_digest = Some("0".repeat(64));
        assert_eq!(
            check_echo(&req, &r).unwrap_err(),
            CalloutError::ResponseMismatch
        );
        let mut r = good.clone();
        r.user_nkey = Some(nkeys::KeyPair::new_user().public_key());
        assert_eq!(
            check_echo(&req, &r).unwrap_err(),
            CalloutError::ResponseMismatch
        );
        let mut r = good.clone();
        r.server_id = Some("NOTHER".into());
        assert_eq!(
            check_echo(&req, &r).unwrap_err(),
            CalloutError::ResponseMismatch
        );
        let mut r = good.clone();
        r.server_id = None;
        assert_eq!(
            check_echo(&req, &r).unwrap_err(),
            CalloutError::ResponseMismatch
        );
        let mut r = good.clone();
        r.permissions = None;
        assert_eq!(
            check_echo(&req, &r).unwrap_err(),
            CalloutError::ResponseMismatch
        );
        let mut r = good.clone();
        r.enforcement = Some("unverified_dev".into());
        assert_eq!(
            check_echo(&req, &r).unwrap_err(),
            CalloutError::ResponseMismatch
        );
        let mut r = good;
        r.decision = "deny".into();
        r.permissions = None;
        r.enforcement = None;
        assert!(check_echo(&req, &r).is_ok(), "a deny needs no permissions");
    }

    #[test]
    fn unknown_fields_in_the_request_are_refused_by_the_host_side_parser() {
        let (req, _) = pair();
        let mut value = serde_json::to_value(&req).unwrap();
        value["project_ids"] = serde_json::json!(["proj_a"]);
        assert!(serde_json::from_value::<HostDecisionRequest>(value).is_err());
    }
}
