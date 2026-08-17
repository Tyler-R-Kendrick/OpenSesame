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
use opensesame_authz::{
    evaluate_callout, issuer_on_allowlist, CalloutDenyReason, CalloutEval,
};
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::app_state::AppState;
use crate::config::constant_time_eq;
use crate::identity_mapping::{IdentityMappingClient, MappedPrincipal, MemoryPrincipalMapper};

/// Shared secret header / bearer for callout requests from the NATS bridge.
pub const CALLOUT_TOKEN_HEADER: &str = "x-opensesame-callout-token";

#[derive(Clone, Debug, Deserialize)]
pub struct NatsCalloutRequest {
    /// OIDC / Identity issuer of the connecting client token.
    #[serde(default)]
    pub issuer: String,
    /// Upstream subject (pairwise or IdP sub) — never an email join key.
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
    if let Some(v) = headers.get(CALLOUT_TOKEN_HEADER).and_then(|v| v.to_str().ok()) {
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
    req.join_by_email
        || req
            .email
            .as_ref()
            .map(|e| !e.trim().is_empty())
            .unwrap_or(false)
}

/// Core decision used by the HTTP handler and golden tests.
pub async fn decide_nats_callout(
    cfg: &CalloutConfig,
    req: NatsCalloutRequest,
    mapped: Option<MappedPrincipal>,
) -> NatsCalloutResponse {
    let req = normalize_request(req);
    let email_join = email_join_attempted(&req);
    let issuer_allowed = issuer_on_allowlist(&req.issuer, &cfg.issuer_allowlist);

    let eval = CalloutEval {
        issuer_allowed,
        email_join_attempted: email_join,
        issuer: req.issuer.clone(),
        subject: req.subject.clone(),
        mapped_principal_id: mapped.as_ref().map(|m| m.principal_id.clone()),
        provisional: mapped.as_ref().map(|m| m.provisional).unwrap_or(false),
        project_ids: req.project_ids.clone(),
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
    State(_st): State<AppState>,
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
        let resp = decide_nats_callout(&cfg, req, None).await;
        return (StatusCode::OK, Json(resp)).into_response();
    }

    let mapped = if req.issuer.is_empty() || req.subject.is_empty() {
        None
    } else {
        match IdentityMappingClient::from_env()
            .resolve_upstream(&req.issuer, &req.subject)
            .await
        {
            Ok(m) => m,
            Err(crate::identity_mapping::MappingClientError::EmailJoinForbidden) => {
                let resp = NatsCalloutResponse {
                    decision: "deny",
                    error: Some(CalloutDenyReason::EmailJoinForbidden.as_str()),
                    principal_id: None,
                    provisional: None,
                    permissions: None,
                    user_nkey: None,
                    server_id: None,
                };
                return (StatusCode::OK, Json(resp)).into_response();
            }
            Err(e) => {
                tracing::warn!(error = %e, "identity mapping resolve failed");
                None
            }
        }
    };

    let resp = decide_nats_callout(&cfg, req, mapped).await;
    (StatusCode::OK, Json(resp)).into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_cfg() -> CalloutConfig {
        CalloutConfig {
            shared_secret: "callout-test-secret".into(),
            issuer_allowlist: "https://identity.test,https://idp.example".into(),
        }
    }

    #[tokio::test]
    async fn deny_unknown_issuer() {
        let cfg = test_cfg();
        let resp = decide_nats_callout(
            &cfg,
            NatsCalloutRequest {
                issuer: "https://evil.example".into(),
                subject: "sub-1".into(),
                user_nkey: "UTEST".into(),
                server_id: "NTEST".into(),
                email: None,
                join_by_email: false,
                project_ids: vec![],
                token_claims: None,
            },
            Some(MappedPrincipal {
                principal_id: "prn_x".into(),
                provisional: false,
                assurance: "verified".into(),
                issuer: "https://evil.example".into(),
                subject: "sub-1".into(),
            }),
        )
        .await;
        assert_eq!(resp.decision, "deny");
        assert_eq!(resp.error, Some("unknown_issuer"));
    }

    #[tokio::test]
    async fn deny_email_join() {
        let cfg = test_cfg();
        let mapper = MemoryPrincipalMapper::new();
        mapper.insert(
            "https://identity.test",
            "sub-1",
            MappedPrincipal {
                principal_id: "prn_mapped".into(),
                provisional: false,
                assurance: "verified".into(),
                issuer: "https://identity.test".into(),
                subject: "sub-1".into(),
            },
        );
        // Even if a mapping exists for issuer+subject, email join flag denies.
        let _ = mapper;
        let resp = decide_nats_callout(
            &cfg,
            NatsCalloutRequest {
                issuer: "https://identity.test".into(),
                subject: "sub-1".into(),
                user_nkey: String::new(),
                server_id: String::new(),
                email: Some("alice@example.com".into()),
                join_by_email: true,
                project_ids: vec!["proj_a".into()],
                token_claims: None,
            },
            Some(MappedPrincipal {
                principal_id: "prn_mapped".into(),
                provisional: false,
                assurance: "verified".into(),
                issuer: "https://identity.test".into(),
                subject: "sub-1".into(),
            }),
        )
        .await;
        assert_eq!(resp.decision, "deny");
        assert_eq!(resp.error, Some("email_join_forbidden"));
    }

    #[tokio::test]
    async fn allow_mapped_principal() {
        let cfg = test_cfg();
        let resp = decide_nats_callout(
            &cfg,
            NatsCalloutRequest {
                issuer: "https://identity.test".into(),
                subject: "oidc-sub-9".into(),
                user_nkey: "UBO2MQV67TQTVIRV3XFTEZOACM4WLOCMCDMAWN5QVN5PI2N6JHTVDRON".into(),
                server_id: "NB5FCQYBGNXSL27AGZYUX5QZ2KKIFUKVDZCL5R7NIUS4562JT4WEWKQV".into(),
                email: None,
                join_by_email: false,
                project_ids: vec!["proj_a".into()],
                token_claims: None,
            },
            Some(MappedPrincipal {
                principal_id: "prn_mapped".into(),
                provisional: false,
                assurance: "verified".into(),
                issuer: "https://identity.test".into(),
                subject: "oidc-sub-9".into(),
            }),
        )
        .await;
        assert_eq!(resp.decision, "allow");
        assert_eq!(resp.principal_id.as_deref(), Some("prn_mapped"));
        assert_eq!(resp.provisional, Some(false));
        let perms = resp.permissions.expect("permissions");
        assert_eq!(
            perms.publish,
            vec!["opensesame.events.project.proj_a.>".to_string()]
        );
        assert_eq!(
            resp.user_nkey.as_deref(),
            Some("UBO2MQV67TQTVIRV3XFTEZOACM4WLOCMCDMAWN5QVN5PI2N6JHTVDRON")
        );
    }

    #[tokio::test]
    async fn deny_unmapped_even_with_allowed_issuer() {
        let cfg = test_cfg();
        let resp = decide_nats_callout(
            &cfg,
            NatsCalloutRequest {
                issuer: "https://identity.test".into(),
                subject: "unknown-sub".into(),
                user_nkey: String::new(),
                server_id: String::new(),
                email: None,
                join_by_email: false,
                project_ids: vec![],
                token_claims: None,
            },
            None,
        )
        .await;
        assert_eq!(resp.decision, "deny");
        assert_eq!(resp.error, Some("unmapped_principal"));
    }

    #[test]
    fn source_never_uses_connection_key() {
        let src = include_str!("nats_callout.rs");
        let code = src.split("#[cfg(test)]").next().unwrap_or(src);
        assert!(
            !code.contains("ENV_CONNECTION") && !code.contains("BrokerConfig::from_env"),
            "callout production path must not load connection seal material"
        );
    }
}
