//! The recipe and signer routes (ADR 0076 §4, ADR 0159): who may call them,
//! that trust comes only from a verification the Host performed, and that
//! every change is compare-and-set and audited without the document.

use axum::http::Request;
use opensesame_domain::OrganizationRole;
use opensesame_rotation_web::recipe_doc::{key_id_of, RecipeDocument};
use serde_json::json;
use tower::ServiceExt;

use super::*;
use crate::app_state::{test_demo_state, test_session_headers};
use crate::test_principals::{P26, P27};
use crate::web_login::recipe_fixture;

pub(super) const SITE: &str = "https://login.example";
pub(super) const SITE_PATH: &str = "https%3A%2F%2Flogin.example";
pub(super) const RECIPES: &str = "/api/v1/web-login/recipes";
pub(super) const SIGNERS: &str = "/api/v1/web-login/signers";

pub(super) struct Reply {
    pub status: StatusCode,
    pub headers: HeaderMap,
    pub body: Value,
}

pub(super) async fn send(
    app: &Router,
    headers: &HeaderMap,
    method: &str,
    uri: &str,
    body: Vec<u8>,
) -> Reply {
    let mut builder = Request::builder().method(method).uri(uri);
    for (name, value) in headers {
        builder = builder.header(name, value);
    }
    let response = app
        .clone()
        .oneshot(builder.body(Body::from(body)).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let headers = response.headers().clone();
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let body = serde_json::from_slice(&bytes).unwrap_or_else(|_| json!({}));
    Reply {
        status,
        headers,
        body,
    }
}

pub(super) fn with(mut headers: HeaderMap, name: &'static str, value: &str) -> HeaderMap {
    headers.insert(name, HeaderValue::from_str(value).unwrap());
    headers
}

pub(super) fn operator(st: &AppState) -> HeaderMap {
    with(
        HeaderMap::new(),
        "authorization",
        &format!("Bearer operator:{}", st.operator_token),
    )
}

/// A session of `role` that has just stepped up with a passkey.
pub(super) fn stepped_up(st: &AppState, subject: &str, role: OrganizationRole) -> HeaderMap {
    let token = uuid::Uuid::new_v4().to_string();
    let mut claims = crate::session_claims::fixture(
        crate::session_claims::parse_principal(subject).unwrap(),
        st.connection_organization,
        role,
        &st.resource,
    );
    claims.assurance = crate::session_claims::Assurance::PhishingResistant;
    claims.amr = vec!["webauthn".into()];
    claims.last_step_up_at = Some(chrono::Utc::now());
    st.sessions
        .lock()
        .unwrap()
        .insert(opensesame_claims::hash_secret(&token), claims);
    with(
        HeaderMap::new(),
        "authorization",
        &format!("Bearer opaque-session:{token}"),
    )
}

pub(super) fn owner(st: &AppState) -> HeaderMap {
    test_session_headers(st, P26, st.connection_organization, OrganizationRole::Owner)
}

pub(super) fn public_key_hex() -> String {
    hex::encode(recipe_fixture::signer().verifying_key().as_bytes())
}

pub(super) fn key_id() -> String {
    key_id_of(&recipe_fixture::signer().verifying_key())
}

/// Pin the fixture signer, as the operator.
pub(super) async fn pin_signer(app: &Router, st: &AppState) -> Reply {
    let body = json!({"public_key": public_key_hex(), "label": "release signer"});
    send(
        app,
        &operator(st),
        "POST",
        SIGNERS,
        body.to_string().into_bytes(),
    )
    .await
}

pub(super) fn put_headers(who: &HeaderMap, if_match: &str) -> HeaderMap {
    with(who.clone(), "if-match", if_match)
}

pub(super) fn document_bytes(document: &RecipeDocument) -> Vec<u8> {
    serde_json::to_vec(document).unwrap()
}

pub(super) fn recipe_uri() -> String {
    format!("{RECIPES}/{SITE_PATH}")
}

pub(super) async fn audit_payloads(st: &AppState, event: &str) -> Vec<String> {
    let stored: Vec<(String, String, String)> = sqlx::query_as(
        "SELECT id, organization_id, payload_json FROM outbox_events WHERE event_type = ? ORDER BY created_at",
    )
    .bind(event)
    .fetch_all(st.db.pool())
    .await
    .unwrap();
    // Sealed at rest once the process-wide sealer is installed (ADR 0157).
    stored
        .iter()
        .map(|(id, organization, payload)| {
            opensesame_event_seal::open_in(organization, "outbox_events.payload_json", id, payload)
                .unwrap()
        })
        .collect()
}

#[tokio::test]
async fn every_route_requires_authentication() {
    let st = test_demo_state().await;
    let app = crate::routes::router(st.clone());
    let uri = recipe_uri();
    for (method, path) in [
        ("GET", RECIPES.to_owned()),
        ("GET", uri.clone()),
        ("PUT", uri.clone()),
        ("DELETE", uri.clone()),
        ("POST", format!("{uri}/canary")),
        ("GET", SIGNERS.to_owned()),
        ("POST", SIGNERS.to_owned()),
        ("DELETE", format!("{SIGNERS}/{}", key_id())),
    ] {
        let reply = send(&app, &HeaderMap::new(), method, &path, b"{}".to_vec()).await;
        assert_eq!(reply.status, StatusCode::UNAUTHORIZED, "{method} {path}");
    }
}

#[tokio::test]
async fn an_agent_credential_never_writes_the_recipes_that_govern_it() {
    let uri = recipe_uri();
    for (method, path) in [
        ("GET", RECIPES.to_owned()),
        ("GET", uri.clone()),
        ("PUT", uri.clone()),
        ("DELETE", uri.clone()),
        ("POST", format!("{uri}/canary")),
        ("GET", SIGNERS.to_owned()),
        ("POST", SIGNERS.to_owned()),
        ("DELETE", format!("{SIGNERS}/{}", key_id())),
    ] {
        assert_eq!(
            crate::middleware::agent_grants::capability(method, &path),
            None,
            "{method} {path}"
        );
        assert_eq!(
            crate::middleware::browser_user_routes::required_capability(method, &path),
            None,
            "{method} {path}"
        );
    }
    let st = test_demo_state().await;
    let token = "a".repeat(64);
    let mut claims = crate::session_claims::fixture(
        crate::session_claims::parse_principal(P26).unwrap(),
        st.connection_organization,
        OrganizationRole::Owner,
        &st.resource,
    );
    claims.credential_kind = CredentialKind::AgentCapability;
    st.sessions
        .lock()
        .unwrap()
        .insert(opensesame_claims::hash_secret(&token), claims);
    let headers = with(
        HeaderMap::new(),
        "authorization",
        &format!("Bearer agent-capability:{token}"),
    );
    // In the handler itself, behind the guard.
    let Err(refused) = admin_caller(&st, &headers) else {
        panic!("an agent capability, owner role and all, writes no recipe");
    };
    assert_eq!(refused.status(), StatusCode::FORBIDDEN);
    // And at the guard, before dispatch.
    let app = crate::routes::router(st);
    let reply = send(&app, &headers, "GET", SIGNERS, Vec::new()).await;
    assert_eq!(reply.status, StatusCode::UNAUTHORIZED, "{}", reply.body);
}

#[tokio::test]
async fn a_member_manages_nothing() {
    let st = test_demo_state().await;
    let app = crate::routes::router(st.clone());
    let member = test_session_headers(
        &st,
        P27,
        st.connection_organization,
        OrganizationRole::Member,
    );
    let uri = recipe_uri();
    for (method, path) in [
        ("GET", RECIPES.to_owned()),
        ("GET", uri.clone()),
        ("PUT", uri.clone()),
        ("DELETE", uri.clone()),
        ("POST", format!("{uri}/canary")),
        ("GET", SIGNERS.to_owned()),
        ("POST", SIGNERS.to_owned()),
        ("DELETE", format!("{SIGNERS}/{}", key_id())),
    ] {
        let headers = put_headers(&member, "\"0\"");
        let reply = send(&app, &headers, method, &path, b"{}".to_vec()).await;
        assert_eq!(reply.status, StatusCode::FORBIDDEN, "{method} {path}");
    }
}

#[tokio::test]
async fn pinning_a_signer_takes_a_step_up_and_revoking_takes_none() {
    let st = test_demo_state().await;
    let app = crate::routes::router(st.clone());
    let body = json!({"public_key": public_key_hex(), "label": "release signer"})
        .to_string()
        .into_bytes();

    // An administrator's plain session is the loop the recipes may govern.
    let plain = owner(&st);
    let refused = send(&app, &plain, "POST", SIGNERS, body.clone()).await;
    assert_eq!(refused.status, StatusCode::FORBIDDEN, "{}", refused.body);
    assert_eq!(refused.body["error"], "step_up_required");
    assert!(
        send(&app, &plain, "GET", SIGNERS, Vec::new()).await.body["signers"]
            .as_array()
            .unwrap()
            .is_empty()
    );

    let fresh = stepped_up(&st, P26, OrganizationRole::Owner);
    let pinned = send(&app, &fresh, "POST", SIGNERS, body.clone()).await;
    assert_eq!(pinned.status, StatusCode::CREATED, "{}", pinned.body);
    assert_eq!(pinned.body["signer"]["key_id"], key_id());
    assert_eq!(pinned.body["signer"]["algorithm"], "ed25519");
    assert_eq!(pinned.body["signer"]["pinned_by"], P26);
    assert_eq!(pinned.body["signer"]["revoked_at"], Value::Null);

    // The same key is never pinned twice, and the operator is a step-up of its own.
    let again = send(&app, &operator(&st), "POST", SIGNERS, body).await;
    assert_eq!(again.status, StatusCode::CONFLICT);
    assert_eq!(again.body["error"], "signer_exists");

    // Revocation is the safe direction: no step-up, and final.
    let path = format!("{SIGNERS}/{}", key_id());
    let revoked = send(&app, &plain, "DELETE", &path, Vec::new()).await;
    assert_eq!(revoked.status, StatusCode::OK, "{}", revoked.body);
    assert_eq!(revoked.body["signer"]["revoked_by"], P26);
    let twice = send(&app, &plain, "DELETE", &path, Vec::new()).await;
    assert_eq!(twice.status, StatusCode::CONFLICT);
    assert_eq!(twice.body["error"], "already_revoked");
    let repin = pin_signer(&app, &st).await;
    assert_eq!(
        repin.status,
        StatusCode::CONFLICT,
        "a revoked key is never pinned again"
    );
    assert_eq!(repin.body["signer"]["revoked_by"], P26);
    let listed = send(&app, &plain, "GET", SIGNERS, Vec::new()).await;
    assert_eq!(listed.body["signers"].as_array().unwrap().len(), 1);

    let unknown = format!("{SIGNERS}/rsk_ffffffffffffffffffffffffffffffff");
    assert_eq!(
        send(&app, &plain, "DELETE", &unknown, Vec::new())
            .await
            .status,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        send(
            &app,
            &plain,
            "DELETE",
            &format!("{SIGNERS}/not-a-key"),
            Vec::new()
        )
        .await
        .status,
        StatusCode::BAD_REQUEST
    );

    let pins = audit_payloads(&st, EVENT_SIGNER_PINNED).await;
    assert_eq!(pins.len(), 1);
    assert!(pins[0].contains(&key_id()) && !pins[0].contains(&public_key_hex()));
    assert_eq!(audit_payloads(&st, EVENT_SIGNER_REVOKED).await.len(), 1);
}

#[tokio::test]
async fn a_pin_request_is_strict() {
    let st = test_demo_state().await;
    let app = crate::routes::router(st.clone());
    let operator = operator(&st);
    let good = public_key_hex();
    for (name, body) in [
        ("not json", "nope".to_owned()),
        ("a bare key", json!(good).to_string()),
        (
            "an extra member",
            json!({"public_key": good, "label": "x", "key_id": "rsk_x"}).to_string(),
        ),
        (
            "a short key",
            json!({"public_key": "abcd", "label": "x"}).to_string(),
        ),
        (
            "not hex",
            json!({"public_key": "z".repeat(64), "label": "x"}).to_string(),
        ),
        (
            "a blank label",
            json!({"public_key": good, "label": "  "}).to_string(),
        ),
        (
            "a long label",
            json!({"public_key": good, "label": "x".repeat(81)}).to_string(),
        ),
        (
            "a control label",
            json!({"public_key": good, "label": "a\nb"}).to_string(),
        ),
    ] {
        let reply = send(&app, &operator, "POST", SIGNERS, body.into_bytes()).await;
        assert_eq!(
            reply.status,
            StatusCode::BAD_REQUEST,
            "{name}: {}",
            reply.body
        );
        assert_eq!(reply.body["error"], "invalid_signer", "{name}");
    }
    let big = vec![b' '; 5 * 1024];
    assert_eq!(
        send(&app, &operator, "POST", SIGNERS, big).await.status,
        StatusCode::PAYLOAD_TOO_LARGE
    );
    assert!(
        send(&app, &operator, "GET", SIGNERS, Vec::new()).await.body["signers"]
            .as_array()
            .unwrap()
            .is_empty()
    );
}
