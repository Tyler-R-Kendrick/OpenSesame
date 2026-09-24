//! NATS auth-callout decision endpoint on the Host plane (ADR 0017 / 0040 /
//! 0130).
//!
//! The bridge (`crates/nats-callout`) POSTs the server-signed
//! `authorization_request` here and gets back an allow/deny bound to that
//! exact request. Three authentications are kept apart and none substitutes
//! for another:
//!
//! 1. **The bridge** is a service caller — an mTLS peer with a
//!    `NatsAuthBridge` binding allowing `nats.callout.decide`. A valid
//!    certificate belonging to some other workload is refused
//!    (AT-CALLOUT-BRIDGE). See [`deployment`].
//! 2. **The NATS server** is re-verified here, from the raw signed request,
//!    against `OPENSESAME_NATS_SERVER_NKEYS`. The bridge's word about who
//!    signed it buys nothing (AT-CALLOUT-PROVENANCE). See [`verify`].
//! 3. **The end user** is authenticated from their own token against the
//!    issuer's JWKS ([`crate::callout_evidence`]). An unsigned issuer+subject
//!    is not authentication and is denied `unsigned_evidence`
//!    (AT-CALLOUT-CLAIMS).
//!
//! Host never decrypts human vault material, never joins by email, and never
//! believes CONNECT-supplied `project_ids`.
//!

use axum::extract::{Request, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use opensesame_authz::{evaluate_callout, issuer_on_allowlist, CalloutEval};
use opensesame_nats_callout::host_client::HostDecisionRequest;
use serde::Serialize;
use serde_json::json;

use crate::app_state::AppState;
use crate::identity_mapping::MappedPrincipal;

use callout_evidence::EvidenceError;

// The evidence verifier lives beside the route rather than in the crate
// root's module list, so this swarm owns every file it needs: nothing in
// `main.rs` has to change for the callout to compile.
#[path = "../callout_evidence.rs"]
pub mod callout_evidence;
#[path = "nats_callout_config.rs"]
mod deployment;
#[path = "nats_callout_verify.rs"]
pub mod verify;

pub use deployment::{authenticate_bridge, CalloutConfig};

/// Shared secret header / bearer, legacy local profile only.
pub const CALLOUT_TOKEN_HEADER: &str = "x-opensesame-callout-token";
/// Largest decision request accepted.
pub const MAX_BODY_BYTES: usize = 64 * 1024;
/// How long a decision — and any user JWT minted from it — is valid.
pub const DECISION_TTL_SECS: i64 = 300;

/// The end-user identity a decision is made about. Deliberately **not**
/// `Deserialize`: it is only ever built from a verified token or a bound
/// certificate, never posted.
#[derive(Clone, Debug, Default)]
pub struct NatsCalloutRequest {
    /// Authenticated upstream issuer.
    pub issuer: String,
    /// Authenticated upstream subject — never an email join key.
    pub subject: String,
    /// Present only so an email-only identity can be refused explicitly.
    pub email: Option<String>,
    pub join_by_email: bool,
    /// Always empty: CONNECT-supplied memberships are self-asserted.
    #[cfg_attr(not(test), allow(dead_code))]
    // Never read by design; tests prove a filled one cannot widen a grant.
    pub project_ids: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
pub struct NatsCalloutResponse {
    pub decision: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub principal_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provisional: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub permissions: Option<opensesame_authz::CalloutPermissions>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user_nkey: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub server_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request_digest: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exp: Option<String>,
    /// `verified` only when a signature produced the identity. The bridge
    /// refuses to sign an allow without it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub enforcement: Option<&'static str>,
}

impl NatsCalloutResponse {
    fn deny(error: impl Into<String>) -> Self {
        Self {
            decision: "deny",
            error: Some(error.into()),
            principal_id: None,
            provisional: None,
            permissions: None,
            user_nkey: None,
            server_id: None,
            request_digest: None,
            exp: None,
            enforcement: None,
        }
    }

    /// Bind a decision to the exact request it was made about.
    fn bind(mut self, to: &Binding<'_>, enforcement: Option<&'static str>) -> Self {
        self.request_digest = Some(to.digest.to_owned());
        self.user_nkey = Some(to.user_nkey.to_owned());
        self.server_id = Some(to.server_id.to_owned());
        if self.decision == "allow" {
            self.exp = Some(to.exp.to_owned());
            self.enforcement = enforcement;
        }
        self
    }
}

struct Binding<'a> {
    digest: &'a str,
    user_nkey: &'a str,
    server_id: &'a str,
    exp: &'a str,
}

/// Core decision: an authenticated identity plus Identity's mapping, nothing
/// else. Kept separate from transport so the golden tests can drive it.
#[must_use]
pub fn decide_nats_callout(
    cfg: &CalloutConfig,
    req: NatsCalloutRequest,
    mapped: Option<MappedPrincipal>,
) -> NatsCalloutResponse {
    let email_join = req.join_by_email || req.email.as_ref().is_some_and(|e| !e.trim().is_empty());
    let issuer_allowed = issuer_on_allowlist(&req.issuer, &cfg.issuer_allowlist);
    let (mapped_principal_id, provisional) = mapped.map_or((None, false), |principal| {
        (Some(principal.principal_id), principal.provisional)
    });

    let eval = CalloutEval {
        issuer_allowed,
        email_join_attempted: email_join,
        issuer: req.issuer,
        subject: req.subject,
        mapped_principal_id,
        provisional,
        // CONNECT-body project_ids are self-asserted. Until Identity mapping
        // supplies memberships, grant only the principal inbox.
        project_ids: vec![],
    };

    match evaluate_callout(&eval) {
        Ok(allow) => NatsCalloutResponse {
            decision: "allow",
            error: None,
            principal_id: Some(allow.principal_id),
            provisional: Some(allow.provisional),
            permissions: Some(allow.permissions),
            user_nkey: None,
            server_id: None,
            request_digest: None,
            exp: None,
            enforcement: None,
        },
        Err(reason) => NatsCalloutResponse::deny(reason.as_str()),
    }
}

pub(crate) fn refuse(status: StatusCode, error: &'static str) -> Response {
    (status, Json(json!({"decision": "deny", "error": error}))).into_response()
}

fn answer(resp: NatsCalloutResponse) -> Response {
    (StatusCode::OK, Json(resp)).into_response()
}

/// `POST /api/v1/nats/auth/callout`.
pub async fn callout(State(st): State<AppState>, request: Request) -> Response {
    let (parts, body) = request.into_parts();
    let Ok(cfg) = CalloutConfig::from_env(st.deployment.production_safeguards()) else {
        return refuse(StatusCode::SERVICE_UNAVAILABLE, "callout_misconfigured");
    };
    if let Err(denied) = authenticate_bridge(&st, &cfg, &parts) {
        return denied;
    }
    let Ok(bytes) = axum::body::to_bytes(body, MAX_BODY_BYTES).await else {
        return refuse(StatusCode::BAD_REQUEST, "malformed_request");
    };
    let Ok(body) = serde_json::from_slice::<HostDecisionRequest>(&bytes) else {
        return refuse(StatusCode::BAD_REQUEST, "malformed_request");
    };
    decide(&st, cfg, &body).await
}

/// The verified path, once the bridge is admitted and the body has parsed.
pub(crate) async fn decide(
    st: &AppState,
    cfg: CalloutConfig,
    body: &HostDecisionRequest,
) -> Response {
    let now = chrono::Utc::now();
    let verified = match verify::verify_request(
        body,
        &cfg.server_nkeys,
        cfg.callout_subject.as_deref(),
        now.timestamp(),
    ) {
        Ok(verified) => verified,
        Err(err) => {
            // Bind the refusal to what the caller claimed, so the bridge can
            // still relay a signed deny; a deny grants nothing either way.
            let claimed = Binding {
                digest: &body.request_digest,
                user_nkey: &body.user_nkey,
                server_id: &body.server.id,
                exp: "",
            };
            return answer(NatsCalloutResponse::deny(err.code()).bind(&claimed, None));
        }
    };
    let exp = (now + chrono::Duration::seconds(DECISION_TTL_SECS)).to_rfc3339();
    let to = Binding {
        digest: verified.digest.as_str(),
        user_nkey: &verified.user_nkey,
        server_id: &verified.server_id,
        exp: &exp,
    };
    // A decision already recorded for this digest is the only answer a retry
    // can ever get (AT-CALLOUT-REPLAY).
    let key = verify::replay_key(&verified.digest);
    if let Ok(Some(stored)) = st.db.get_host_kv(&key).await {
        return replay(&stored, now.timestamp());
    }
    // Every decision made about a verified request is recorded, denies
    // included, so a retry cannot flip to a different answer because policy
    // moved underneath it (AT-CALLOUT-REPLAY).
    let resp = match decide_identity(st, &cfg, &verified, &to).await {
        Ok(resp) => resp,
        Err(refusal) => return refusal,
    };
    match record(st, &key, &resp).await {
        Some(theirs) => replay(&theirs, now.timestamp()),
        None => answer(resp),
    }
}

/// Authenticate the end user, map them, and decide. `Err` is a refusal that
/// is *not* a decision about this request (a misconfigured Host), so it is
/// never recorded.
async fn decide_identity(
    st: &AppState,
    cfg: &CalloutConfig,
    verified: &verify::VerifiedCallout,
    to: &Binding<'_>,
) -> Result<NatsCalloutResponse, Response> {
    let identity = match resolve_identity(cfg, verified).await {
        Ok(identity) => identity,
        Err(code) => return Ok(NatsCalloutResponse::deny(code).bind(to, None)),
    };
    let enforcement = identity.enforcement;
    let req = NatsCalloutRequest {
        issuer: identity.issuer,
        subject: identity.subject,
        email: identity.email,
        join_by_email: identity.join_by_email,
        project_ids: vec![],
    };
    let mapped = if req.join_by_email || req.issuer.is_empty() || req.subject.is_empty() {
        None
    } else {
        let Some(mapping) = &st.identity_mapping else {
            return Err(refuse(
                StatusCode::SERVICE_UNAVAILABLE,
                "callout_misconfigured",
            ));
        };
        match mapping.resolve_upstream(&req.issuer, &req.subject).await {
            Ok(m) => m,
            Err(e) => {
                tracing::warn!(error = %e, "identity mapping resolve failed");
                // An unavailable mapping denies. It never falls back to a
                // broader grant and never adds a callout-bypass user.
                return Ok(NatsCalloutResponse::deny("mapping_unavailable").bind(to, None));
            }
        }
    };
    Ok(decide_nats_callout(cfg, req, mapped).bind(to, enforcement))
}

/// The end user, once authenticated.
struct Identity {
    issuer: String,
    subject: String,
    email: Option<String>,
    join_by_email: bool,
    /// `Some("verified")` only when a signature produced this identity.
    enforcement: Option<&'static str>,
}

/// Authenticate the end user: their token first, then any bound certificate,
/// then the relationship between the two.
async fn resolve_identity(
    cfg: &CalloutConfig,
    verified: &verify::VerifiedCallout,
) -> Result<Identity, String> {
    let token = match verified.evidence.upstream_token.as_deref() {
        Some(token) => Some(
            cfg.evidence
                .verify(token, chrono::Utc::now().timestamp())
                .await
                .map_err(|err| err.code().to_owned())?,
        ),
        None => None,
    };
    let cert = verify::cert_identity(verified, cfg.cert_identity, &cfg.cert_peers)
        .map_err(str::to_owned)?;
    let email = token.as_ref().and_then(|claims| claims.email.clone());
    let pair = token.map(|claims| (claims.iss, claims.sub));
    match verify::reconcile(pair, &cert).map_err(str::to_owned)? {
        Some((issuer, subject)) => Ok(Identity {
            issuer,
            subject,
            email,
            join_by_email: false,
            enforcement: Some("verified"),
        }),
        None => match &cfg.dev_identity {
            Some((issuer, subject)) => {
                tracing::warn!("callout identity taken from the development profile, not a token");
                Ok(Identity {
                    issuer: issuer.clone(),
                    subject: subject.clone(),
                    email: None,
                    join_by_email: false,
                    enforcement: Some("unverified_dev"),
                })
            }
            None => Err(EvidenceError::Missing.code().to_owned()),
        },
    }
}

/// Answer a retried request with the decision already recorded, unless that
/// decision has itself expired.
fn replay(stored: &str, now: i64) -> Response {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(stored) else {
        return answer(NatsCalloutResponse::deny("replay_unreadable"));
    };
    let still_valid = value
        .get("exp")
        .and_then(serde_json::Value::as_str)
        .and_then(|exp| chrono::DateTime::parse_from_rfc3339(exp).ok())
        .is_some_and(|exp| exp.timestamp() > now);
    if value.get("decision").and_then(serde_json::Value::as_str) == Some("allow") && !still_valid {
        return answer(NatsCalloutResponse::deny("decision_expired"));
    }
    (StatusCode::OK, Json(value)).into_response()
}

/// Record the decision atomically. Returns the decision another replica
/// already recorded for this digest, which wins: a retry can never alter
/// permissions.
async fn record(st: &AppState, key: &str, resp: &NatsCalloutResponse) -> Option<String> {
    let encoded = serde_json::to_string(resp).ok()?;
    match st.db.try_claim_host_kv(key, &encoded).await {
        Ok(true) => None,
        Ok(false) => st.db.get_host_kv(key).await.ok().flatten(),
        Err(e) => {
            tracing::warn!(error = %e, "callout decision could not be recorded");
            None
        }
    }
}

#[cfg(test)]
#[path = "nats_callout_tests.rs"]
mod tests;
