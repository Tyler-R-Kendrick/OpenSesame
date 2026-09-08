//! NATS auth callout HTTP endpoint on the Host plane (ADR 0017 / 0040).
//!
//! NATS auth callout services (or a local bridge) POST an authorization request
//! here. Host evaluates issuer allowlist + Identity mapping + authz permissions
//! and returns allow/deny. Never decrypts human vault material. Never joins by
//! email. Never uses the Host connection / deployment seal key for xkey E2EE.

use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    response::IntoResponse,
    Json,
};
use opensesame_authz::{evaluate_callout, issuer_on_allowlist, CalloutEval};
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::app_state::AppState;
use crate::config::constant_time_eq;
use crate::identity_mapping::MappedPrincipal;

/// Shared secret header / bearer for callout requests from the NATS bridge.
pub const CALLOUT_TOKEN_HEADER: &str = "x-opensesame-callout-token";

#[derive(Clone, Debug, Deserialize)]
pub struct NatsCalloutRequest {
    /// OIDC / Identity issuer of the connecting client token.
    #[serde(default)]
    pub issuer: String,
    /// Upstream subject (pairwise or `IdP` sub) — never an email join key.
    #[serde(default)]
    pub subject: String,
    /// NATS one-time user nkey from the authorization request (echoed on allow).
    #[serde(default)]
    pub user_nkey: String,
    /// NATS server id (audience for a full JWT response; echoed for bridges).
    #[serde(default)]
    pub server_id: String,
    /// When set, the client attempted email-only correlation — always denied.
    #[serde(default)]
    pub email: Option<String>,
    /// Explicit flag for email-join attempts (golden-test seam).
    #[serde(default)]
    pub join_by_email: bool,
    /// Optional project ids for verified member subject scoping.
    #[serde(default)]
    #[allow(dead_code)]
    pub project_ids: Vec<String>,
    /// Optional nested token claims (iss/sub preferred when top-level empty).
    #[serde(default)]
    pub token_claims: Option<TokenClaims>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct TokenClaims {
    #[serde(default)]
    pub iss: String,
    #[serde(default)]
    pub sub: String,
    #[serde(default)]
    pub email: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
pub struct NatsCalloutResponse {
    pub decision: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<&'static str>,
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
}

#[derive(Clone, Debug)]
pub struct CalloutConfig {
    pub shared_secret: String,
    pub issuer_allowlist: String,
}

impl CalloutConfig {
    pub fn from_env() -> Self {
        Self {
            shared_secret: std::env::var("OPENSESAME_NATS_CALLOUT_SECRET").unwrap_or_default(),
            issuer_allowlist: std::env::var("OPENSESAME_NATS_CALLOUT_ISSUERS").unwrap_or_default(),
        }
    }
}

fn extract_callout_token(headers: &HeaderMap) -> Option<String> {
    if let Some(v) = headers
        .get(CALLOUT_TOKEN_HEADER)
        .and_then(|v| v.to_str().ok())
    {
        let t = v.trim();
        if !t.is_empty() {
            return Some(t.to_string());
        }
    }
    let auth = headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())?;
    let lower = auth.to_ascii_lowercase();
    if let Some(rest) = lower.strip_prefix("bearer ") {
        let start = auth.len() - rest.len();
        let token = auth[start..].trim();
        if !token.is_empty() {
            return Some(token.to_string());
        }
    }
    None
}

fn require_callout_auth(cfg: &CalloutConfig, headers: &HeaderMap) -> Result<(), StatusCode> {
    if cfg.shared_secret.is_empty() {
        // Misconfigured: refuse rather than open the callout.
        return Err(StatusCode::SERVICE_UNAVAILABLE);
    }
    let Some(presented) = extract_callout_token(headers) else {
        return Err(StatusCode::UNAUTHORIZED);
    };
    if !constant_time_eq(&presented, &cfg.shared_secret) {
        return Err(StatusCode::UNAUTHORIZED);
    }
    Ok(())
}

fn normalize_request(mut req: NatsCalloutRequest) -> NatsCalloutRequest {
    if let Some(claims) = &req.token_claims {
        if req.issuer.is_empty() && !claims.iss.is_empty() {
            req.issuer = claims.iss.clone();
        }
        if req.subject.is_empty() && !claims.sub.is_empty() {
            req.subject = claims.sub.clone();
        }
        if req.email.is_none() {
            req.email = claims.email.clone();
        }
    }
    req
}

fn email_join_attempted(req: &NatsCalloutRequest) -> bool {
    req.join_by_email || req.email.as_ref().is_some_and(|e| !e.trim().is_empty())
}

/// Core decision used by the HTTP handler and golden tests.
pub fn decide_nats_callout(
    cfg: &CalloutConfig,
    req: NatsCalloutRequest,
    mapped: Option<MappedPrincipal>,
) -> NatsCalloutResponse {
    let req = normalize_request(req);
    let email_join = email_join_attempted(&req);
    let issuer_allowed = issuer_on_allowlist(&req.issuer, &cfg.issuer_allowlist);
    let (mapped_principal_id, provisional) = mapped.map_or((None, false), |principal| {
        (Some(principal.principal_id), principal.provisional)
    });

    let eval = CalloutEval {
        issuer_allowed,
        email_join_attempted: email_join,
        issuer: req.issuer.clone(),
        subject: req.subject.clone(),
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
            user_nkey: if req.user_nkey.is_empty() {
                None
            } else {
                Some(req.user_nkey)
            },
            server_id: if req.server_id.is_empty() {
                None
            } else {
                Some(req.server_id)
            },
        },
        Err(reason) => NatsCalloutResponse {
            decision: "deny",
            error: Some(reason.as_str()),
            principal_id: None,
            provisional: None,
            permissions: None,
            user_nkey: None,
            server_id: None,
        },
    }
}

pub async fn callout(
    State(st): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<NatsCalloutRequest>,
) -> impl IntoResponse {
    let cfg = CalloutConfig::from_env();
    if let Err(status) = require_callout_auth(&cfg, &headers) {
        return (
            status,
            Json(json!({
                "decision": "deny",
                "error": if status == StatusCode::SERVICE_UNAVAILABLE {
                    "callout_misconfigured"
                } else {
                    "unauthorized"
                }
            })),
        )
            .into_response();
    }

    let req = normalize_request(body);
    if email_join_attempted(&req) {
        // Short-circuit before Identity: email must never be sent as a join key.
        let resp = decide_nats_callout(&cfg, req, None);
        return (StatusCode::OK, Json(resp)).into_response();
    }

    let mapped = if req.issuer.is_empty() || req.subject.is_empty() {
        None
    } else {
        let Some(mapping) = &st.identity_mapping else {
            return (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(json!({"decision":"deny","error":"callout_misconfigured"})),
            )
                .into_response();
        };
        match mapping.resolve_upstream(&req.issuer, &req.subject).await {
            Ok(m) => m,
            Err(e) => {
                tracing::warn!(error = %e, "identity mapping resolve failed");
                None
            }
        }
    };

    let resp = decide_nats_callout(&cfg, req, mapped);
    (StatusCode::OK, Json(resp)).into_response()
}

#[cfg(test)]
#[expect(
    clippy::items_after_statements,
    reason = "the callout tests define scenario-local mapper fixtures beside their use"
)]
#[path = "nats_callout_tests.rs"]
mod tests;
