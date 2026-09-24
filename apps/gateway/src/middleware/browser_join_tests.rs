//! The join ceremony's routes, as a browser reaches them (ADR 0136).
//!
//! Through the real router and the real guard: a paired browser nobody has
//! verified by passkey reaches none of them; a verified one reaches exactly
//! the ask and the listing, answered with the codes the Pages client maps,
//! and still cannot decide or grant.

use crate::app_state::AppState;
use crate::routes::shared_sessions::tests::{actor, open_session, state};
use axum::body::{to_bytes, Body};
use axum::http::{header, Request, StatusCode};
use axum::response::Response;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use opensesame_claims::hash_secret;
use opensesame_domain::OrganizationId;
use opensesame_storage::browser_pairing::NewBrowserPairing;
use serde_json::{json, Value};
use tower::ServiceExt;

const ORIGIN: &str = "https://join.example";

struct Browser {
    token: String,
    jwk: opensesame_proof::DpopPublicJwk,
    key: opensesame_proof::ProofSigningKey,
}

fn proof_key() -> (
    opensesame_proof::DpopPublicJwk,
    opensesame_proof::ProofSigningKey,
) {
    let pair = rcgen::KeyPair::generate_for(&rcgen::PKCS_ECDSA_P256_SHA256).unwrap();
    let public = pair.public_key_raw();
    let jwk = serde_json::from_value(json!({"kty":"EC","crv":"P-256",
        "x":URL_SAFE_NO_PAD.encode(&public[1..33]),"y":URL_SAFE_NO_PAD.encode(&public[33..65])}))
    .unwrap();
    (
        jwk,
        opensesame_proof::ProofSigningKey::from_ec_der(&pair.serialize_der()),
    )
}

/// A browser the operator approved for `principal`, optionally verified.
async fn browser(state: &AppState, principal: &str, organization: &str, verified: bool) -> Browser {
    let (jwk, key) = proof_key();
    let jkt = opensesame_proof::jwk_thumbprint(&jwk).unwrap();
    let now = chrono::Utc::now().timestamp();
    let id = uuid::Uuid::new_v4().to_string();
    let raw = uuid::Uuid::new_v4().simple().to_string().repeat(2);
    let device = format!("device-{id}");
    let code = format!("code-{id}");
    state
        .db
        .create_browser_pairing(&NewBrowserPairing {
            id: &id,
            device_digest: &device,
            user_code_digest: &code,
            origin: ORIGIN,
            dpop_jkt: &jkt,
            audience: &state.resource,
            // What the Pages join ceremony asks for (ADR 0136).
            capabilities_json: "[\"host.join\"]",
            now,
        })
        .await
        .unwrap();
    state
        .db
        .decide_browser_pairing(&code, principal, organization, true, now)
        .await
        .unwrap();
    state
        .db
        .consume_browser_pairing(&device, ORIGIN, &jkt, &hash_secret(&raw), now)
        .await
        .unwrap()
        .unwrap();
    if verified {
        // What `host-authorizations/verify` writes after a passkey ceremony.
        sqlx::query("UPDATE browser_clients SET authentication_json=? WHERE id=?")
            .bind(format!(r#"{{"role":"member","auth_time":{now}}}"#))
            .bind(&id)
            .execute(state.db.pool())
            .await
            .unwrap();
    }
    Browser {
        token: format!("opaque-session:{raw}"),
        jwk,
        key,
    }
}

async fn send(
    router: &axum::Router,
    state: &AppState,
    who: &Browser,
    method: &str,
    uri: &str,
    body: Option<Value>,
) -> (StatusCode, Value) {
    // The bound URI is the path without its query, as the client signs it.
    let path = uri.split('?').next().unwrap();
    let claims = opensesame_proof::DpopClaims {
        jti: uuid::Uuid::new_v4().to_string(),
        htm: method.into(),
        htu: format!("{}{path}", state.resource.trim_end_matches('/')),
        iat: chrono::Utc::now().timestamp(),
        ath: Some(opensesame_proof::access_token_hash(&who.token)),
    };
    let proof = opensesame_proof::sign_dpop_proof(&who.jwk, &who.key, &claims).unwrap();
    let mut request = Request::builder()
        .method(method)
        .uri(uri)
        .header(header::ORIGIN, ORIGIN)
        .header(header::AUTHORIZATION, format!("DPoP {}", who.token))
        .header("dpop", proof);
    if body.is_some() {
        request = request.header(header::CONTENT_TYPE, "application/json");
    }
    let request = request
        .body(body.map_or_else(Body::empty, |value| Body::from(value.to_string())))
        .unwrap();
    let response = router.clone().oneshot(request).await.unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), 1 << 20).await.unwrap();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}

async fn preflight(router: &axum::Router, method: &str, path: &str) -> Response {
    let request = Request::builder()
        .method("OPTIONS")
        .uri(path)
        .header(header::ORIGIN, ORIGIN)
        .header(header::ACCESS_CONTROL_REQUEST_METHOD, method)
        .header(
            header::ACCESS_CONTROL_REQUEST_HEADERS,
            "authorization,content-type,dpop",
        )
        .body(Body::empty())
        .unwrap();
    router.clone().oneshot(request).await.unwrap()
}

/// One organization with a public and a private session, and a joiner.
struct Room {
    state: AppState,
    router: axum::Router,
    open: String,
    private: String,
    joiner: String,
    org: String,
    _lock: std::sync::MutexGuard<'static, ()>,
}

impl Room {
    async fn new() -> Self {
        let state = Box::pin(state()).await;
        let lock = crate::app_state::test_env::lock();
        std::env::set_var("OPENSESAME_BROWSER_PAIRABLE_ORIGINS", ORIGIN);
        let router = crate::routes::router(state.clone());
        let organization = OrganizationId::new();
        let operator = actor(&state, organization);
        let open = open_session(&router, &operator, "public").await;
        let private = open_session(&router, &operator, "private").await;
        Self {
            state,
            router,
            open,
            private,
            joiner: opensesame_domain::PrincipalId::new().to_string(),
            org: organization.to_string(),
            _lock: lock,
        }
    }

    fn asks(&self) -> String {
        format!("/api/v1/shared-sessions/{}/join-requests", self.open)
    }

    async fn browser(&self, verified: bool) -> Browser {
        browser(&self.state, &self.joiner, &self.org, verified).await
    }

    async fn send(
        &self,
        who: &Browser,
        method: &str,
        uri: &str,
        body: Option<Value>,
    ) -> (StatusCode, Value) {
        send(&self.router, &self.state, who, method, uri, body).await
    }
}

impl Drop for Room {
    fn drop(&mut self) {
        std::env::remove_var("OPENSESAME_BROWSER_PAIRABLE_ORIGINS");
    }
}

#[tokio::test]
async fn an_approved_browser_nobody_verified_reaches_no_join_route() {
    let room = Room::new().await;
    let paired = room.browser(false).await;
    let asks = room.asks();
    for (method, uri) in [
        ("GET", "/api/v1/shared-sessions?visibility=public"),
        ("POST", asks.as_str()),
        ("POST", "/api/v1/delegations/present"),
        ("POST", "/api/v1/delegations/claim"),
    ] {
        let (status, body) = room.send(&paired, method, uri, Some(json!({}))).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED, "{method} {uri}: {body}");
        assert_eq!(body["error"], "capability_denied", "{method} {uri}");
    }
}

#[tokio::test]
async fn a_verified_join_grant_holds_nothing_but_the_join() {
    let room = Room::new().await;
    let verified = room.browser(true).await;
    // Routes any other verified browser reaches: a join grant reaches none.
    for (method, uri) in [
        ("GET", "/api/v1/connections"),
        ("POST", "/api/v1/connections"),
        ("POST", "/api/v1/delegations"),
        ("GET", "/api/v1/tasks"),
        ("GET", "/api/v1/relay/requests/pending"),
        ("POST", "/api/v1/sync/pull"),
    ] {
        let (status, body) = room.send(&verified, method, uri, Some(json!({}))).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED, "{method} {uri}: {body}");
        assert_eq!(body["error"], "capability_denied", "{method} {uri}");
    }
}

#[tokio::test]
async fn a_refusal_is_readable_by_the_paired_page() {
    // Without CORS on the refusal the page sees a network failure and cannot
    // tell "verify again" from "offline".
    let room = Room::new().await;
    let paired = room.browser(false).await;
    let claims = opensesame_proof::DpopClaims {
        jti: uuid::Uuid::new_v4().to_string(),
        htm: "POST".into(),
        htu: format!(
            "{}/api/v1/delegations/claim",
            room.state.resource.trim_end_matches('/')
        ),
        iat: chrono::Utc::now().timestamp(),
        ath: Some(opensesame_proof::access_token_hash(&paired.token)),
    };
    let proof = opensesame_proof::sign_dpop_proof(&paired.jwk, &paired.key, &claims).unwrap();
    let request = Request::builder()
        .method("POST")
        .uri("/api/v1/delegations/claim")
        .header(header::ORIGIN, ORIGIN)
        .header(header::AUTHORIZATION, format!("DPoP {}", paired.token))
        .header("dpop", proof)
        .body(Body::from("{}"))
        .unwrap();
    let response = room.router.clone().oneshot(request).await.unwrap();
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    assert_eq!(
        response.headers()[header::ACCESS_CONTROL_ALLOW_ORIGIN],
        ORIGIN
    );
}

#[tokio::test]
async fn a_verified_browser_lists_and_asks_with_the_codes_the_page_maps() {
    let room = Room::new().await;
    let verified = room.browser(true).await;
    let (status, body) = room
        .send(
            &verified,
            "GET",
            "/api/v1/shared-sessions?visibility=public",
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let listed: Vec<&str> = body["sessions"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|entry| entry["id"].as_str())
        .collect();
    assert_eq!(listed, vec![room.open.as_str()]);

    // Asking is pending; asking twice is the same ask; a private session is
    // not there to ask into.
    let note = json!({"note": "from the design team"});
    let asks = room.asks();
    let (status, body) = room
        .send(&verified, "POST", &asks, Some(note.clone()))
        .await;
    assert_eq!(status, StatusCode::ACCEPTED, "{body}");
    assert_eq!(body["decision"], "pending");
    let (status, body) = room.send(&verified, "POST", &asks, Some(note)).await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(body["error"], "join_request_pending");
    let private = format!("/api/v1/shared-sessions/{}/join-requests", room.private);
    let (status, _) = room
        .send(&verified, "POST", &private, Some(json!({})))
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    // The delegation routes answer the handler's own codes, not the guard's.
    let (status, _) = room
        .send(
            &verified,
            "POST",
            "/api/v1/delegations/present",
            Some(json!({"claim_token": "osc_dlg_dlgo_x.unknown"})),
        )
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn a_verified_browser_may_ask_in_but_never_let_itself_in() {
    let room = Room::new().await;
    let verified = room.browser(true).await;
    let asks = room.asks();
    let (_, body) = room.send(&verified, "POST", &asks, Some(json!({}))).await;
    let request_id = body["id"].as_str().unwrap().to_owned();
    let (status, body) = room
        .send(
            &verified,
            "POST",
            &format!("{asks}/{request_id}/decide"),
            Some(json!({"decision": "admitted", "mode": "observer"})),
        )
        .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED, "{body}");
    assert_eq!(body["error"], "capability_denied");

    // The preflight the page sends first is answered for its routes only.
    for (method, path) in [
        ("GET", "/api/v1/shared-sessions"),
        ("POST", asks.as_str()),
        ("POST", "/api/v1/delegations/present"),
        ("POST", "/api/v1/delegations/claim"),
    ] {
        let response = preflight(&room.router, method, path).await;
        assert_eq!(response.status(), StatusCode::NO_CONTENT, "{method} {path}");
        assert_eq!(
            response.headers()[header::ACCESS_CONTROL_ALLOW_ORIGIN],
            ORIGIN
        );
    }
    let decide = format!("{asks}/{request_id}/decide");
    let response = preflight(&room.router, "POST", &decide).await;
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
}
