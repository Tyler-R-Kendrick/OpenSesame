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
use crate::identity_mapping::{IdentityMappingClient, MappedPrincipal};

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
    use crate::identity_mapping::MemoryPrincipalMapper;

    fn env_lock() -> std::sync::MutexGuard<'static, ()> {
        crate::app_state::test_env::lock()
    }

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
                user_nkey: "UBO2MQV67TQTVIRV3XFTEZOACM4WLOCMCDMAWN5QVN5PI2N6JHTVDRON".into(), // gitleaks:allow -- public test NKey
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
            vec!["opensesame.callout.principal.prn_mapped.>".to_string()]
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
        opensesame_host_core::pact::assert_source_order(src, &["project_ids: vec![]"]);
        let code = src.split("#[cfg(test)]").next().unwrap_or(src);
        assert!(
            !code.contains("ENV_CONNECTION") && !code.contains("BrokerConfig::from_env"),
            "callout production path must not load connection seal material"
        );
    }

    #[tokio::test]
    async fn http_callout_requires_shared_secret() {
        let _guard = env_lock();
        use crate::app_state;
        use crate::config::Args;
        use axum::body::{to_bytes, Body};
        use axum::http::Request;
        use tower::ServiceExt;

        let prev = std::env::var_os("OPENSESAME_NATS_CALLOUT_SECRET");
        std::env::remove_var("OPENSESAME_NATS_CALLOUT_SECRET");
        let state = app_state::build(Args {
            listen: "127.0.0.1:0".parse().unwrap(),
            resource: "https://opensesame.local".into(),
            issuer: "https://issuer.local".into(),
            database_url: "sqlite::memory:".into(),
            task_database_url: String::new(),
        })
        .await
        .unwrap();
        let request = Request::builder()
            .method("POST")
            .uri("/api/v1/nats/auth/callout")
            .header("content-type", "application/json")
            .body(Body::from(r#"{"issuer":"https://identity.test","subject":"s1"}"#))
            .unwrap();
        let response = crate::routes::router(state).oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
        match prev {
            Some(v) => std::env::set_var("OPENSESAME_NATS_CALLOUT_SECRET", v),
            None => std::env::remove_var("OPENSESAME_NATS_CALLOUT_SECRET"),
        }
        let _ = to_bytes(response.into_body(), 1024).await;
    }

    #[tokio::test]
    async fn http_callout_allow_never_includes_system_subjects() {
        let _guard = env_lock();
        use crate::app_state;
        use crate::config::Args;
        use axum::body::{to_bytes, Body};
        use axum::http::Request;
        use opensesame_authz::permissions_include_system;
        use tower::ServiceExt;

        let prev_secret = std::env::var_os("OPENSESAME_NATS_CALLOUT_SECRET");
        let prev_issuers = std::env::var_os("OPENSESAME_NATS_CALLOUT_ISSUERS");
        std::env::set_var("OPENSESAME_NATS_CALLOUT_SECRET", "callout-http-test");
        std::env::set_var(
            "OPENSESAME_NATS_CALLOUT_ISSUERS",
            "https://identity.test,https://idp.example",
        );
        let state = app_state::build(Args {
            listen: "127.0.0.1:0".parse().unwrap(),
            resource: "https://opensesame.local".into(),
            issuer: "https://issuer.local".into(),
            database_url: "sqlite::memory:".into(),
            task_database_url: String::new(),
        })
        .await
        .unwrap();
        let request = Request::builder()
            .method("POST")
            .uri("/api/v1/nats/auth/callout")
            .header("content-type", "application/json")
            .header("x-opensesame-callout-token", "callout-http-test")
            .body(Body::from(
                serde_json::json!({
                    "issuer": "https://identity.test",
                    "subject": "oidc-sub-http",
                    "project_ids": ["proj_a"],
                })
                .to_string(),
            ))
            .unwrap();
        let response = crate::routes::router(state).oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let bytes = to_bytes(response.into_body(), 4096).await.unwrap();
        let body: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(body["decision"], "deny");
        assert_eq!(body["error"], "unmapped_principal");

        // Mapped principal path via decide (unit); HTTP unmapped above is enough for deny.
        let cfg = test_cfg();
        let allow = decide_nats_callout(
            &cfg,
            NatsCalloutRequest {
                issuer: "https://identity.test".into(),
                subject: "sub-mapped".into(),
                user_nkey: String::new(),
                server_id: String::new(),
                email: None,
                join_by_email: false,
                project_ids: vec!["proj_a".into()],
                token_claims: None,
            },
            Some(MappedPrincipal {
                principal_id: "prn_http".into(),
                provisional: false,
                assurance: "verified".into(),
                issuer: "https://identity.test".into(),
                subject: "sub-mapped".into(),
            }),
        )
        .await;
        assert_eq!(allow.decision, "allow");
        let perms = allow.permissions.expect("permissions");
        assert!(!permissions_include_system(&perms));
        assert!(
            !perms
                .subscribe
                .iter()
                .chain(perms.publish.iter())
                .any(|s| s.contains("proj_a")),
            "self-asserted project_ids must not grant project event subjects"
        );

        match prev_secret {
            Some(v) => std::env::set_var("OPENSESAME_NATS_CALLOUT_SECRET", v),
            None => std::env::remove_var("OPENSESAME_NATS_CALLOUT_SECRET"),
        }
        match prev_issuers {
            Some(v) => std::env::set_var("OPENSESAME_NATS_CALLOUT_ISSUERS", v),
            None => std::env::remove_var("OPENSESAME_NATS_CALLOUT_ISSUERS"),
        }
    }

    #[tokio::test]
    async fn http_callout_rejects_bad_token() {
        let _guard = env_lock();
        use crate::app_state;
        use crate::config::Args;
        use axum::body::Body;
        use axum::http::Request;
        use tower::ServiceExt;

        let prev = std::env::var_os("OPENSESAME_NATS_CALLOUT_SECRET");
        std::env::set_var("OPENSESAME_NATS_CALLOUT_SECRET", "good-secret");
        let state = app_state::build(Args {
            listen: "127.0.0.1:0".parse().unwrap(),
            resource: "https://opensesame.local".into(),
            issuer: "https://issuer.local".into(),
            database_url: "sqlite::memory:".into(),
            task_database_url: String::new(),
        })
        .await
        .unwrap();
        let request = Request::builder()
            .method("POST")
            .uri("/api/v1/nats/auth/callout")
            .header("content-type", "application/json")
            .header("x-opensesame-callout-token", "wrong-secret")
            .body(Body::from(r#"{"issuer":"https://identity.test","subject":"s1"}"#))
            .unwrap();
        let response = crate::routes::router(state).oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        match prev {
            Some(v) => std::env::set_var("OPENSESAME_NATS_CALLOUT_SECRET", v),
            None => std::env::remove_var("OPENSESAME_NATS_CALLOUT_SECRET"),
        }
    }

    #[tokio::test]
    async fn http_callout_missing_token_fails_closed() {
        let _guard = env_lock();
        use crate::app_state;
        use crate::config::Args;
        use axum::body::{to_bytes, Body};
        use axum::http::Request;
        use tower::ServiceExt;

        let prev = std::env::var_os("OPENSESAME_NATS_CALLOUT_SECRET");
        std::env::set_var("OPENSESAME_NATS_CALLOUT_SECRET", "good-secret");
        let state = app_state::build(Args {
            listen: "127.0.0.1:0".parse().unwrap(),
            resource: "https://opensesame.local".into(),
            issuer: "https://issuer.local".into(),
            database_url: "sqlite::memory:".into(),
            task_database_url: String::new(),
        })
        .await
        .unwrap();
        let request = Request::builder()
            .method("POST")
            .uri("/api/v1/nats/auth/callout")
            .header("content-type", "application/json")
            .body(Body::from(r#"{"issuer":"https://identity.test","subject":"s1"}"#))
            .unwrap();
        let response = crate::routes::router(state).oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        let body = to_bytes(response.into_body(), 1024).await.unwrap();
        let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(json["decision"], "deny");
        assert_eq!(json["error"], "unauthorized");
        let text = json.to_string();
        assert!(!text.contains("good-secret"));
        assert!(!text.contains("access_token"));
        match prev {
            Some(v) => std::env::set_var("OPENSESAME_NATS_CALLOUT_SECRET", v),
            None => std::env::remove_var("OPENSESAME_NATS_CALLOUT_SECRET"),
        }
    }

    #[tokio::test]
    async fn mapping_partition_denies_rather_than_allowing() {
        let cfg = test_cfg();
        for n in 0..32 {
            let resp = decide_nats_callout(
                &cfg,
                NatsCalloutRequest {
                    issuer: "https://identity.test".into(),
                    subject: format!("sub-{n}"),
                    user_nkey: "UTEST".into(),
                    server_id: "NTEST".into(),
                    email: None,
                    join_by_email: false,
                    project_ids: vec![format!("proj_{n}")],
                    token_claims: None,
                },
                None,
            )
            .await;
            assert_eq!(resp.decision, "deny");
            assert_eq!(resp.error, Some("unmapped_principal"));
            assert!(resp.permissions.is_none());
            let wire = serde_json::to_value(&resp).unwrap();
            assert!(wire.get("shared_secret").is_none());
            assert!(wire.get("access_token").is_none());
            assert!(wire.get("email").is_none());
        }
    }
}
