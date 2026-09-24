use super::{local_mint, revoke_matching_sessions, revoke_pending_authorizations, whoami};
use crate::app_state::{ApprovedDevice, DevicePending};
use crate::session_claims::fixture;
use axum::extract::State;
use axum::http::StatusCode;
use chrono::{Duration, Utc};
use opensesame_domain::{OrganizationId, OrganizationRole, PrincipalId};
use serde_json::json;
use std::{
    collections::HashMap,
    sync::{mpsc, Arc, Barrier, Mutex},
    thread,
};

#[test]
fn revocation_is_scoped_to_principal_and_organization() {
    let principal = PrincipalId::new();
    let org = OrganizationId::new();
    let mut sessions = HashMap::from([
        (
            "target".into(),
            fixture(
                principal,
                org,
                OrganizationRole::Member,
                "https://host.test",
            ),
        ),
        (
            "other-principal".into(),
            fixture(
                PrincipalId::new(),
                org,
                OrganizationRole::Member,
                "https://host.test",
            ),
        ),
        (
            "other-org".into(),
            fixture(
                principal,
                OrganizationId::new(),
                OrganizationRole::Member,
                "https://host.test",
            ),
        ),
    ]);
    assert_eq!(
        revoke_matching_sessions(&mut sessions, &principal.to_string(), &org.to_string()),
        1
    );
    assert!(!sessions.contains_key("target"));
    assert!(sessions.contains_key("other-principal"));
    assert!(sessions.contains_key("other-org"));
}

#[test]
fn revocation_clears_matching_approved_device_codes() {
    let organization_id = OrganizationId::new();
    let approved = |principal: &str, organization_id| DevicePending {
        user_code_hash: "digest".into(),
        client_id: "opensesame-cli".into(),
        scope: "opensesame.session".into(),
        expires_at: Utc::now() + Duration::minutes(5),
        approved: Some(ApprovedDevice {
            principal: principal.into(),
            organization_id,
            organization_role: OrganizationRole::Member,
        }),
    };
    let mut pending = HashMap::from([
        ("target".into(), approved("prn_target", organization_id)),
        ("other".into(), approved("prn_other", organization_id)),
    ]);
    assert_eq!(
        revoke_pending_authorizations(&mut pending, "prn_target", organization_id),
        1
    );
    assert!(pending["target"].approved.is_none());
    assert!(pending["other"].approved.is_some());
}

#[test]
fn revocation_normalizes_identity_and_host_principal_spellings() {
    let principal = PrincipalId::new();
    let identity_principal = format!("prn_{}", principal.as_uuid());
    let organization_id = OrganizationId::new();
    let mut sessions = HashMap::from([(
        "target".into(),
        fixture(
            principal,
            organization_id,
            OrganizationRole::Member,
            "https://host.test",
        ),
    )]);
    let mut pending = HashMap::from([(
        "target".into(),
        DevicePending {
            user_code_hash: "digest".into(),
            client_id: "opensesame-cli".into(),
            scope: "opensesame.session".into(),
            expires_at: Utc::now() + Duration::minutes(5),
            approved: Some(ApprovedDevice {
                principal: principal.to_string(),
                organization_id,
                organization_role: OrganizationRole::Member,
            }),
        },
    )]);

    assert_eq!(
        revoke_matching_sessions(
            &mut sessions,
            &identity_principal,
            &organization_id.to_string(),
        ),
        1
    );
    assert_eq!(
        revoke_pending_authorizations(&mut pending, &identity_principal, organization_id,),
        1
    );
    assert!(sessions.is_empty());
    assert!(pending["target"].approved.is_none());
}

#[test]
fn revocation_matches_the_canonical_organization_spelling() {
    let organization_id = OrganizationId::new();
    let principal = PrincipalId::new();
    let mut sessions = HashMap::from([(
        "target".into(),
        fixture(
            principal,
            organization_id,
            OrganizationRole::Member,
            "https://host.test",
        ),
    )]);

    let bare_request_id = organization_id.as_uuid().to_string();
    let normalized = OrganizationId::parse(&bare_request_id)
        .expect("bare UUID is accepted at the API boundary")
        .to_string();
    assert_eq!(
        revoke_matching_sessions(&mut sessions, &principal.to_string(), &normalized),
        1
    );
    assert!(sessions.is_empty());
}

#[test]
fn revocation_waiting_on_a_token_mint_clears_the_new_session() {
    let organization_id = OrganizationId::new();
    let principal = PrincipalId::new();
    let lifecycle = Arc::new(Mutex::new(()));
    let sessions = Arc::new(Mutex::new(HashMap::new()));
    let pending = Arc::new(Mutex::new(HashMap::from([(
        "device".to_string(),
        DevicePending {
            user_code_hash: "digest".into(),
            client_id: "opensesame-cli".into(),
            scope: "opensesame.session".into(),
            expires_at: Utc::now() + Duration::minutes(5),
            approved: Some(ApprovedDevice {
                principal: principal.to_string(),
                organization_id,
                organization_role: OrganizationRole::Member,
            }),
        },
    )])));
    let mint_ready = Arc::new(Barrier::new(2));
    let release_mint = Arc::new(Barrier::new(2));

    let mint = {
        let lifecycle = Arc::clone(&lifecycle);
        let sessions = Arc::clone(&sessions);
        let pending = Arc::clone(&pending);
        let mint_ready = Arc::clone(&mint_ready);
        let release_mint = Arc::clone(&release_mint);
        thread::spawn(move || {
            let _fence = lifecycle.lock().unwrap();
            mint_ready.wait();
            release_mint.wait();
            pending.lock().unwrap().remove("device");
            sessions.lock().unwrap().insert(
                "new-session".into(),
                fixture(
                    principal,
                    organization_id,
                    OrganizationRole::Member,
                    "https://host.test",
                ),
            );
        })
    };
    mint_ready.wait();

    let (contending, contending_rx) = mpsc::channel();
    let revoke = {
        let lifecycle = Arc::clone(&lifecycle);
        let sessions = Arc::clone(&sessions);
        let pending = Arc::clone(&pending);
        thread::spawn(move || {
            contending.send(()).unwrap();
            let _fence = lifecycle.lock().unwrap();
            revoke_matching_sessions(
                &mut sessions.lock().unwrap(),
                &principal.to_string(),
                &organization_id.to_string(),
            );
            revoke_pending_authorizations(
                &mut pending.lock().unwrap(),
                &principal.to_string(),
                organization_id,
            );
        })
    };
    contending_rx.recv().unwrap();
    assert!(
        lifecycle.try_lock().is_err(),
        "mint holds the lifecycle fence"
    );
    release_mint.wait();
    mint.join().unwrap();
    revoke.join().unwrap();

    assert!(sessions.lock().unwrap().is_empty());
    assert!(pending.lock().unwrap().is_empty());
}

#[tokio::test]
async fn connection_listing_hides_another_organizations_bootstrap() {
    let state = crate::app_state::test_demo_state().await;
    let headers = crate::app_state::test_session_headers(
        &state,
        &PrincipalId::new().to_string(),
        OrganizationId::new(),
        OrganizationRole::Member,
    );

    let response = super::list_connections(State(state), &headers);
    let body = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let body: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(body, json!({"connections": []}));
}

#[tokio::test]
async fn connection_listing_keeps_the_matching_organizations_bootstrap() {
    let state = crate::app_state::test_demo_state().await;
    let organization_id = state.bootstrap.lock().unwrap().as_ref().unwrap().org;
    let headers = crate::app_state::test_session_headers(
        &state,
        &PrincipalId::new().to_string(),
        organization_id,
        OrganizationRole::Member,
    );

    let response = super::list_connections(State(state), &headers);
    let body = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let body: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(body["connections"].as_array().map(Vec::len), Some(1));
}

#[tokio::test]
async fn session_whoami_does_not_require_demo_bootstrap() {
    let state = crate::app_state::test_demo_state().await;
    let organization_id = OrganizationId::new();
    let principal = PrincipalId::new();
    let headers = crate::app_state::test_session_headers(
        &state,
        &principal.to_string(),
        organization_id,
        OrganizationRole::Admin,
    );
    *state.bootstrap.lock().unwrap() = None;

    let response = whoami(State(state), headers).await;
    assert_eq!(response.status(), axum::http::StatusCode::OK);
    let body = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let body: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(body["principal_id"], principal.to_string());
    assert_eq!(body["organization_id"], organization_id.to_string());
    assert_eq!(body["organization_role"], "admin");
    assert!(body["actor_id"].is_null());
    assert!(body["context"].is_null());
}

#[tokio::test]
async fn local_mint_refuses_unpaired_browsers_and_retired_credentials() {
    let state = crate::app_state::test_demo_state().await;
    for (origin, token) in [
        (None, None),
        (None, Some("opensesame-dev-operator")),
        (
            Some("https://tyler-r-kendrick.github.io"),
            Some(state.operator_token.as_str()),
        ),
        (
            Some("http://localhost:5180"),
            Some(state.operator_token.as_str()),
        ),
    ] {
        let mut headers = axum::http::HeaderMap::new();
        if let Some(origin) = origin {
            headers.insert("origin", origin.parse().unwrap());
        }
        if let Some(token) = token {
            headers.insert("x-opensesame-operator", token.parse().unwrap());
        }
        let response = local_mint(State(state.clone()), headers).await;
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        assert!(state.sessions.lock().unwrap().is_empty());
    }
}

#[tokio::test]
async fn local_mint_issues_opaque_session_from_demo_bootstrap() {
    let state = crate::app_state::test_demo_state().await;
    let boot = state.bootstrap.lock().unwrap().clone().unwrap();

    let mut operator = axum::http::HeaderMap::new();
    operator.insert(
        "x-opensesame-operator",
        state.operator_token.parse().unwrap(),
    );
    let response = local_mint(State(state.clone()), operator).await;
    assert_eq!(response.status(), StatusCode::OK);
    let body = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let body: serde_json::Value = serde_json::from_slice(&body).unwrap();
    let token = body["access_token"].as_str().unwrap();
    assert!(token.starts_with("opaque-session:"));
    assert_eq!(body["local_session"], true);
    assert_eq!(body["session"]["organization_id"], boot.org.to_string());
    assert_eq!(body["session"]["assurance"], "local_unverified");
    assert!(body["session"].get("session_id").is_none());
    assert_eq!(body.to_string().matches(token).count(), 1);

    let mut headers = axum::http::HeaderMap::new();
    headers.insert(
        axum::http::header::AUTHORIZATION,
        format!("Bearer {token}").parse().unwrap(),
    );
    let whoami = whoami(State(state), headers).await;
    assert_eq!(whoami.status(), StatusCode::OK);
}

#[tokio::test]
async fn local_mint_requires_demo_bootstrap() {
    let state = crate::app_state::test_demo_state().await;
    *state.bootstrap.lock().unwrap() = None;
    let mut operator = axum::http::HeaderMap::new();
    operator.insert(
        "x-opensesame-operator",
        state.operator_token.parse().unwrap(),
    );
    let response = local_mint(State(state), operator).await;
    assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
}
