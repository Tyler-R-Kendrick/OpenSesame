use std::collections::HashMap;

use axum::body::{to_bytes, Body};
use axum::http::Request;
use opensesame_nats_callout::fixtures::Parties;
use opensesame_nats_callout::host_client::{check_echo, HostDecisionRequest, HostDecisionResponse};
use opensesame_nats_callout::jwt::{decode_request, Expectations};
use tower::ServiceExt;

use super::*;
use crate::config::Args;

fn env_lock() -> std::sync::MutexGuard<'static, ()> {
    crate::app_state::test_env::lock()
}

fn cfg_from(pairs: &[(&str, &str)]) -> CalloutConfig {
    let env: HashMap<String, String> = pairs
        .iter()
        .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
        .collect();
    CalloutConfig::from_lookup(false, &|name| env.get(name).cloned()).expect("config")
}

fn test_cfg() -> CalloutConfig {
    cfg_from(&[
        ("OPENSESAME_NATS_CALLOUT_SECRET", "callout-test-secret"),
        (
            "OPENSESAME_NATS_CALLOUT_ISSUERS",
            "https://identity.test,https://idp.example",
        ),
    ])
}

fn identity(issuer: &str, subject: &str) -> NatsCalloutRequest {
    NatsCalloutRequest {
        issuer: issuer.into(),
        subject: subject.into(),
        email: None,
        join_by_email: false,
        project_ids: vec![],
    }
}

/// A signed request and the body a bridge would post for it.
fn signed_body(parties: &Parties, token: &str) -> (HostDecisionRequest, i64) {
    let now = chrono::Utc::now().timestamp();
    let raw = parties.signed_request(now, token);
    let verified = decode_request(
        &raw,
        &Expectations {
            server_public_keys: vec![],
            callout_subject: None,
            now,
        },
    )
    .expect("fixture verifies");
    (HostDecisionRequest::from_verified(&verified), now)
}

async fn state() -> crate::app_state::AppState {
    crate::app_state::build_test(Args {
        listen: "127.0.0.1:0".parse().unwrap(),
        resource: "https://opensesame.local".into(),
        issuer: "https://issuer.local".into(),
        database_url: "sqlite::memory:".into(),
        task_database_url: String::new(),
    })
    .await
    .unwrap()
}

fn post(body: &str, secret: Option<&str>) -> Request<Body> {
    let mut builder = Request::builder()
        .method("POST")
        .uri("/api/v1/nats/auth/callout")
        .header("content-type", "application/json");
    if let Some(secret) = secret {
        builder = builder.header("x-opensesame-callout-token", secret);
    }
    builder.body(Body::from(body.to_owned())).unwrap()
}

async fn json_of(response: axum::response::Response) -> serde_json::Value {
    let body = to_bytes(response.into_body(), 64 * 1024).await.unwrap();
    serde_json::from_slice(&body).unwrap_or(serde_json::Value::Null)
}

struct EnvGuard(Vec<(&'static str, Option<std::ffi::OsString>)>);

impl EnvGuard {
    fn set(pairs: &[(&'static str, &str)]) -> Self {
        let saved = pairs
            .iter()
            .map(|(name, value)| {
                let prev = std::env::var_os(name);
                std::env::set_var(name, value);
                (*name, prev)
            })
            .collect();
        Self(saved)
    }
}

impl Drop for EnvGuard {
    fn drop(&mut self) {
        for (name, prev) in &self.0 {
            match prev {
                Some(value) => std::env::set_var(name, value),
                None => std::env::remove_var(name),
            }
        }
    }
}

#[test]
fn deny_unknown_issuer() {
    let resp = decide_nats_callout(&test_cfg(), identity("https://evil.example", "s1"), None);
    assert_eq!(resp.decision, "deny");
    assert_eq!(resp.error.as_deref(), Some("unknown_issuer"));
    assert!(resp.permissions.is_none());
}

#[test]
fn deny_email_join() {
    let cfg = test_cfg();
    let mut req = identity("https://identity.test", "s1");
    req.email = Some("person@example.com".into());
    let resp = decide_nats_callout(&cfg, req, None);
    assert_eq!(resp.error.as_deref(), Some("email_join_forbidden"));
    let mut req = identity("https://identity.test", "s1");
    req.join_by_email = true;
    let resp = decide_nats_callout(&cfg, req, None);
    assert_eq!(resp.error.as_deref(), Some("email_join_forbidden"));
}

#[test]
fn allow_mapped_principal_never_gets_system_subjects() {
    let mapped = MappedPrincipal {
        principal_id: "prn_1".into(),
        provisional: false,
        assurance: "verified".into(),
        issuer: "https://identity.test".into(),
        subject: "s1".into(),
    };
    let resp = decide_nats_callout(
        &test_cfg(),
        identity("https://identity.test", "s1"),
        Some(mapped),
    );
    assert_eq!(resp.decision, "allow");
    let permissions = resp.permissions.expect("permissions");
    assert!(!opensesame_authz::permissions_include_system(&permissions));
    assert!(permissions
        .publish
        .iter()
        .all(|s| s.starts_with("opensesame.callout.principal.prn_1.")));
}

#[test]
fn deny_unmapped_even_with_allowed_issuer() {
    let resp = decide_nats_callout(&test_cfg(), identity("https://identity.test", "s1"), None);
    assert_eq!(resp.error.as_deref(), Some("unmapped_principal"));
}

#[test]
fn self_asserted_project_ids_never_widen_a_grant() {
    let cfg = test_cfg();
    for n in 0..32 {
        let mut req = identity("https://identity.test", &format!("sub-{n}"));
        req.project_ids = vec![format!("proj_{n}")];
        let resp = decide_nats_callout(&cfg, req, None);
        assert_eq!(resp.decision, "deny");
        assert_eq!(resp.error.as_deref(), Some("unmapped_principal"));
        let wire = serde_json::to_value(&resp).unwrap();
        assert!(wire.get("email").is_none());
        assert!(wire.get("shared_secret").is_none());
    }
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

#[test]
fn the_route_no_longer_accepts_self_asserted_issuer_and_subject() {
    // AT-CALLOUT-CLAIMS at the parser: the legacy unsigned body cannot even
    // be deserialized, so there is no network-reachable path that maps an
    // issuer+subject nobody signed for.
    assert!(serde_json::from_str::<HostDecisionRequest>(
        r#"{"issuer":"https://identity.test","subject":"s1"}"#
    )
    .is_err());
}

#[tokio::test]
async fn http_callout_requires_a_shared_secret_to_be_configured() {
    let _guard = env_lock();
    let prev = std::env::var_os("OPENSESAME_NATS_CALLOUT_SECRET");
    std::env::remove_var("OPENSESAME_NATS_CALLOUT_SECRET");
    let response = crate::routes::router(state().await)
        .oneshot(post("{}", None))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(json_of(response).await["error"], "callout_misconfigured");
    match prev {
        Some(v) => std::env::set_var("OPENSESAME_NATS_CALLOUT_SECRET", v),
        None => std::env::remove_var("OPENSESAME_NATS_CALLOUT_SECRET"),
    }
}

#[tokio::test]
async fn http_callout_rejects_a_wrong_or_missing_token() {
    let _guard = env_lock();
    let _env = EnvGuard::set(&[("OPENSESAME_NATS_CALLOUT_SECRET", "good-secret")]);
    for presented in [None, Some("wrong-secret")] {
        let response = crate::routes::router(state().await)
            .oneshot(post("{}", presented))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        let json = json_of(response).await;
        assert_eq!(json["error"], "unauthorized");
        assert!(!json.to_string().contains("good-secret"));
    }
}

#[tokio::test]
async fn http_callout_denies_a_request_with_no_verifiable_user_evidence() {
    let _guard = env_lock();
    let parties = Parties::generate();
    let _env = EnvGuard::set(&[
        ("OPENSESAME_NATS_CALLOUT_SECRET", "good-secret"),
        ("OPENSESAME_NATS_SERVER_NKEYS", &parties.server.public_key()),
        (
            "OPENSESAME_NATS_CALLOUT_SUBJECT",
            &parties.account.public_key(),
        ),
    ]);
    let (body, _) = signed_body(&parties, "");
    let response = crate::routes::router(state().await)
        .oneshot(post(
            &serde_json::to_string(&body).unwrap(),
            Some("good-secret"),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let json = json_of(response).await;
    assert_eq!(json["decision"], "deny");
    assert_eq!(json["error"], "unsigned_evidence");
    assert!(json.get("permissions").is_none());
    assert!(json.get("enforcement").is_none());
    // The deny is still bound to the exact request it answers.
    assert_eq!(json["request_digest"], body.request_digest);
    assert_eq!(json["user_nkey"], body.user_nkey);
}

#[tokio::test]
async fn http_callout_refuses_a_server_this_deployment_never_pinned() {
    let _guard = env_lock();
    let real = Parties::generate();
    let forger = Parties::generate();
    let _env = EnvGuard::set(&[
        ("OPENSESAME_NATS_CALLOUT_SECRET", "good-secret"),
        ("OPENSESAME_NATS_SERVER_NKEYS", &real.server.public_key()),
        (
            "OPENSESAME_NATS_CALLOUT_SUBJECT",
            &forger.account.public_key(),
        ),
    ]);
    let (body, _) = signed_body(&forger, "");
    let response = crate::routes::router(state().await)
        .oneshot(post(
            &serde_json::to_string(&body).unwrap(),
            Some("good-secret"),
        ))
        .await
        .unwrap();
    let json = json_of(response).await;
    assert_eq!(json["decision"], "deny");
    assert_eq!(json["error"], "server_unknown");
}

#[tokio::test]
async fn http_callout_refuses_every_request_when_no_server_is_pinned() {
    let _guard = env_lock();
    let parties = Parties::generate();
    let _env = EnvGuard::set(&[
        ("OPENSESAME_NATS_CALLOUT_SECRET", "good-secret"),
        ("OPENSESAME_NATS_SERVER_NKEYS", ""),
    ]);
    let (body, _) = signed_body(&parties, "");
    let response = crate::routes::router(state().await)
        .oneshot(post(
            &serde_json::to_string(&body).unwrap(),
            Some("good-secret"),
        ))
        .await
        .unwrap();
    assert_eq!(json_of(response).await["error"], "server_unknown");
}

#[tokio::test]
async fn http_callout_replays_one_immutable_decision_per_digest() {
    let _guard = env_lock();
    let parties = Parties::generate();
    let _env = EnvGuard::set(&[
        ("OPENSESAME_NATS_CALLOUT_SECRET", "good-secret"),
        ("OPENSESAME_NATS_SERVER_NKEYS", &parties.server.public_key()),
        (
            "OPENSESAME_NATS_CALLOUT_SUBJECT",
            &parties.account.public_key(),
        ),
    ]);
    let st = state().await;
    let (body, _) = signed_body(&parties, "");
    let encoded = serde_json::to_string(&body).unwrap();
    let first = json_of(
        crate::routes::router(st.clone())
            .oneshot(post(&encoded, Some("good-secret")))
            .await
            .unwrap(),
    )
    .await;
    // Even with the issuer allowlist widened between the two calls, the
    // recorded decision is the only answer a retry can get.
    std::env::set_var("OPENSESAME_NATS_CALLOUT_ISSUERS", "https://identity.test");
    let second = json_of(
        crate::routes::router(st.clone())
            .oneshot(post(&encoded, Some("good-secret")))
            .await
            .unwrap(),
    )
    .await;
    std::env::remove_var("OPENSESAME_NATS_CALLOUT_ISSUERS");
    assert_eq!(first, second);
    assert_eq!(first["decision"], "deny");
    assert!(st
        .db
        .get_host_kv(&verify::replay_key(
            &opensesame_nats_callout::RequestDigest::parse(body.request_digest.as_str()).unwrap()
        ))
        .await
        .unwrap()
        .is_some());
}

#[test]
fn a_development_decision_can_never_become_a_user_credential() {
    // The dev hatch stamps `unverified_dev`; the bridge's own echo check
    // refuses to sign any allow that is not `verified`, so the hatch cannot
    // produce a working NATS user however it is configured.
    let parties = Parties::generate();
    let (req, _) = signed_body(&parties, "");
    let dev = HostDecisionResponse {
        decision: "allow".into(),
        permissions: Some(opensesame_authz::CalloutPermissions {
            publish: vec!["opensesame.callout.principal.p.>".into()],
            subscribe: vec![],
        }),
        user_nkey: Some(req.user_nkey.clone()),
        server_id: Some(req.server.id.clone()),
        request_digest: Some(req.request_digest.clone()),
        exp: Some("2100-01-01T00:00:00Z".into()),
        enforcement: Some("unverified_dev".into()),
        ..HostDecisionResponse::default()
    };
    assert!(check_echo(&req, &dev).is_err());
    let verified = HostDecisionResponse {
        enforcement: Some("verified".into()),
        ..dev
    };
    assert!(check_echo(&req, &verified).is_ok());
}
