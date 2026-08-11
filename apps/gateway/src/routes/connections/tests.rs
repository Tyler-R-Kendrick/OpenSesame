//! The connection lifecycle end to end, against an in-process authorization
//! server that genuinely verifies PKCE. Nothing here reaches the network.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};

use axum::{
    body::{to_bytes, Body},
    extract::{Form, Query, State as AxumState},
    http::{Request, StatusCode},
    response::{IntoResponse, Response as AxumResponse},
    routing::{get, post},
    Json as AxumJson, Router,
};
use base64::Engine;
use opensesame_connection_broker::{
    crypto::{self, SealedBlob},
    store, BrokerConfig, ConnectionBroker, ProviderConfig,
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tower::ServiceExt;

use crate::app_state::{self, AppState};
use crate::config::{Args, DEV_OPERATOR_TOKEN};
use crate::middleware::auth::Caller;

#[tokio::test]
async fn operator_can_select_org_but_session_cannot_spoof_it() {
    let state = app_state::build(Args {
        listen: "127.0.0.1:0".parse().unwrap(),
        resource: "https://opensesame.local".into(),
        issuer: "https://issuer.local".into(),
        database_url: "sqlite::memory:".into(),
        task_database_url: String::new(),
    })
    .await
    .unwrap();
    let selected = opensesame_domain::OrganizationId::new();
    let mut headers = axum::http::HeaderMap::new();
    headers.insert(
        super::OPERATOR_ORGANIZATION_HEADER,
        selected.to_string().parse().unwrap(),
    );
    assert_eq!(
        super::caller_organization(&state, &Caller::Operator, &headers).unwrap(),
        selected
    );
    let session = Caller::Session {
        subject: "principal:member".into(),
        organization_id: opensesame_domain::OrganizationId::new(),
        role: opensesame_domain::OrganizationRole::Member,
    };
    assert!(super::caller_organization(&state, &session, &headers).is_err());
    headers.insert(
        super::OPERATOR_ORGANIZATION_HEADER,
        axum::http::HeaderValue::from_bytes(b"\xff").unwrap(),
    );
    let error = super::caller_organization(&state, &Caller::Operator, &headers).unwrap_err();
    assert_eq!(error.status(), StatusCode::BAD_REQUEST);
}

#[test]
fn connection_json_bodies_are_bounded_before_parsing() {
    let body = "x".repeat(32 * 1024 + 1);
    let error = match super::parse_body::<super::CreateIntegrationBody>(&body) {
        Ok(_) => panic!("oversized body accepted"),
        Err(error) => error,
    };
    assert_eq!(error.status(), StatusCode::PAYLOAD_TOO_LARGE);
}

#[tokio::test]
async fn credential_value_limit_applies_to_the_value_not_json_overhead() {
    let (state, _server) = harness().await;
    let (status, created) = call(
        &state,
        "POST",
        "/api/v1/connections",
        Some(json!({"provider_id":"stripe"})),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{created}");
    let id = created["connection_id"].as_str().unwrap();
    let (status, body) = call(
        &state,
        "POST",
        &format!("/api/v1/connections/{id}/credential"),
        Some(json!({"value":"k".repeat(opensesame_connection_broker::MAX_CREDENTIAL_BYTES)})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
}

const CLIENT_ID: &str = "mock-client-id";
const CLIENT_SECRET: &str = "mock-client-secret-do-not-leak";
const ACCESS_TOKEN_1: &str = "at-1-do-not-leak";
const REFRESH_TOKEN_1: &str = "rt-1-do-not-leak";
const ACCESS_TOKEN_2: &str = "at-2-do-not-leak";
const REFRESH_TOKEN_2: &str = "rt-2-do-not-leak";
const AUTH_CODE: &str = "authorization-code-do-not-leak";

// ---- in-test authorization server -------------------------------------------

#[derive(Default)]
struct AuthServerState {
    /// code -> (code_challenge, redirect_uri, scope)
    codes: HashMap<String, (String, String, String)>,
    live_refresh_tokens: HashSet<String>,
    reject_refresh: bool,
    refreshes: u32,
}

type SharedAuthServer = Arc<Mutex<AuthServerState>>;

fn oauth_error(code: &str) -> AxumResponse {
    (StatusCode::BAD_REQUEST, AxumJson(json!({"error": code}))).into_response()
}

async fn as_authorize(
    AxumState(state): AxumState<SharedAuthServer>,
    Query(q): Query<HashMap<String, String>>,
) -> AxumResponse {
    if q.get("client_id").map(String::as_str) != Some(CLIENT_ID) {
        return oauth_error("invalid_client");
    }
    if q.get("response_type").map(String::as_str) != Some("code") {
        return oauth_error("unsupported_response_type");
    }
    if q.get("code_challenge_method").map(String::as_str) != Some("S256") {
        return oauth_error("invalid_request");
    }
    let (Some(challenge), Some(redirect_uri), Some(request_state)) = (
        q.get("code_challenge"),
        q.get("redirect_uri"),
        q.get("state"),
    ) else {
        return oauth_error("invalid_request");
    };
    state.lock().expect("lock").codes.insert(
        AUTH_CODE.to_string(),
        (
            challenge.clone(),
            redirect_uri.clone(),
            q.get("scope").cloned().unwrap_or_default(),
        ),
    );
    let location = format!("{redirect_uri}?code={AUTH_CODE}&state={request_state}");
    (
        StatusCode::FOUND,
        [(axum::http::header::LOCATION, location)],
    )
        .into_response()
}

async fn as_token(
    AxumState(state): AxumState<SharedAuthServer>,
    Form(form): Form<HashMap<String, String>>,
) -> AxumResponse {
    if form.get("client_id").map(String::as_str) != Some(CLIENT_ID)
        || form.get("client_secret").map(String::as_str) != Some(CLIENT_SECRET)
    {
        return oauth_error("invalid_client");
    }
    let mut state = state.lock().expect("lock");
    match form.get("grant_type").map(String::as_str) {
        Some("authorization_code") => {
            let (Some(code), Some(verifier)) = (form.get("code"), form.get("code_verifier")) else {
                return oauth_error("invalid_request");
            };
            let Some((challenge, redirect_uri, scope)) = state.codes.remove(code) else {
                return oauth_error("invalid_grant");
            };
            if form.get("redirect_uri") != Some(&redirect_uri) {
                return oauth_error("invalid_grant");
            }
            // The whole point of PKCE: the verifier must hash to the challenge.
            if s256(verifier) != challenge {
                return oauth_error("invalid_grant");
            }
            state
                .live_refresh_tokens
                .insert(REFRESH_TOKEN_1.to_string());
            AxumJson(json!({
                "access_token": ACCESS_TOKEN_1,
                "refresh_token": REFRESH_TOKEN_1,
                "token_type": "Bearer",
                "expires_in": 3600,
                "scope": scope,
            }))
            .into_response()
        }
        Some("refresh_token") => {
            let Some(presented) = form.get("refresh_token") else {
                return oauth_error("invalid_request");
            };
            if state.reject_refresh {
                return oauth_error("invalid_grant");
            }
            if !state.live_refresh_tokens.remove(presented) {
                return oauth_error("invalid_grant");
            }
            state.refreshes += 1;
            state
                .live_refresh_tokens
                .insert(REFRESH_TOKEN_2.to_string());
            AxumJson(json!({
                "access_token": ACCESS_TOKEN_2,
                "refresh_token": REFRESH_TOKEN_2,
                "token_type": "Bearer",
                "expires_in": 3600,
                "scope": "read offline_access",
            }))
            .into_response()
        }
        _ => oauth_error("unsupported_grant_type"),
    }
}

fn s256(verifier: &str) -> String {
    use sha2::{Digest, Sha256};
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}

struct AuthServer {
    base_url: String,
    state: SharedAuthServer,
}

impl AuthServer {
    async fn start() -> Self {
        let state: SharedAuthServer = Arc::new(Mutex::new(AuthServerState::default()));
        let app = Router::new()
            .route("/authorize", get(as_authorize))
            .route("/token", post(as_token))
            .with_state(state.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind");
        let base_url = format!("http://{}", listener.local_addr().expect("addr"));
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        Self { state, base_url }
    }

    fn refreshes(&self) -> u32 {
        self.state.lock().expect("lock").refreshes
    }

    fn reject_refresh(&self) {
        self.state.lock().expect("lock").reject_refresh = true;
    }
}

// ---- harness ------------------------------------------------------------------

async fn harness() -> (AppState, AuthServer) {
    let server = AuthServer::start().await;
    let state = app_state::build(Args {
        listen: "127.0.0.1:0".parse().expect("listen"),
        resource: "https://opensesame.local".into(),
        issuer: "https://issuer.local".into(),
        database_url: "sqlite::memory:".into(),
        task_database_url: String::new(),
    })
    .await
    .expect("app state");

    let config = BrokerConfig::in_memory(Some([11u8; 32]), "http://127.0.0.1:8787").with_provider(
        "mock",
        ProviderConfig {
            client_id: Some(CLIENT_ID.into()),
            client_secret: Some(CLIENT_SECRET.into()),
            authorize_url: Some(format!("{}/authorize", server.base_url)),
            token_url: Some(format!("{}/token", server.base_url)),
        },
    );
    let mut state = state;
    state.connection_broker = Arc::new(
        ConnectionBroker::new(state.db.pool().clone(), config).expect("connection broker"),
    );
    // These routes are about broker-stored connections. A developer running with
    // OPENSESAME_DEV_BOOTSTRAP set would otherwise inherit the demo's connection
    // ref and see list results this harness never created.
    state.connection_ref = None;
    (state, server)
}

fn operator() -> (&'static str, String) {
    (
        "authorization",
        format!("Bearer operator:{DEV_OPERATOR_TOKEN}"),
    )
}

async fn send(state: &AppState, request: Request<Body>) -> (StatusCode, String) {
    let response = super::super::router(state.clone())
        .oneshot(request)
        .await
        .expect("router");
    let status = response.status();
    let bytes = to_bytes(response.into_body(), usize::MAX)
        .await
        .expect("body");
    (status, String::from_utf8_lossy(&bytes).to_string())
}

async fn call(
    state: &AppState,
    method: &str,
    uri: &str,
    body: Option<Value>,
) -> (StatusCode, Value) {
    let (header, value) = operator();
    let mut builder = Request::builder()
        .method(method)
        .uri(uri)
        .header(header, value);
    let body = match body {
        Some(v) => {
            builder = builder.header("content-type", "application/json");
            Body::from(v.to_string())
        }
        None => Body::empty(),
    };
    let (status, raw) = send(state, builder.body(body).expect("request")).await;
    let parsed = serde_json::from_str(&raw).unwrap_or(Value::String(raw));
    (status, parsed)
}

/// The denylist in `crates/authz/src/authority_use.rs` in literal form: nothing a
/// route emits may carry credential material or the values used to obtain it.
fn assert_no_credential_material(label: &str, body: &str, verifier: &str) {
    for banned in [
        ACCESS_TOKEN_1,
        ACCESS_TOKEN_2,
        REFRESH_TOKEN_1,
        REFRESH_TOKEN_2,
        AUTH_CODE,
        CLIENT_SECRET,
        verifier,
        "code_verifier",
        "access_token",
        "client_secret",
        "secret://",
    ] {
        assert!(
            !banned.is_empty() && !body.contains(banned),
            "{label} leaked `{banned}`: {body}"
        );
    }
    // `refresh_token` as a Salesforce scope name is legitimate; as a field is not.
    assert!(
        !body.contains("\"refresh_token\""),
        "{label} carries a refresh_token field: {body}"
    );
    opensesame_authz::assert_no_secret_in_agent_payload(
        &serde_json::from_str::<Value>(body).unwrap_or(Value::Null),
    )
    .expect(label);
}

async fn stored_verifier(state: &AppState, oauth_state: &str) -> String {
    use sqlx::Row;
    let state_digest: String = Sha256::digest(oauth_state.as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    let row = sqlx::query(
        "SELECT connection_id, code_verifier, verifier_nonce, verifier_aad_digest \
         FROM connection_authorizations WHERE state = ?",
    )
    .bind(state_digest)
    .fetch_one(state.db.pool())
    .await
    .expect("authorization row");
    let connection_id = row.get::<String, _>("connection_id");
    let sealed = SealedBlob {
        ciphertext: row.get("code_verifier"),
        nonce: row.get("verifier_nonce"),
        aad_digest: row.get("verifier_aad_digest"),
    };
    String::from_utf8(
        crypto::open(
            &[11_u8; 32],
            &connection_id,
            &state.connection_organization.to_string(),
            &sealed,
        )
        .expect("open verifier fixture"),
    )
    .expect("UTF-8 verifier")
}

/// Drives create → authorize → provider consent → callback, leaving an active
/// connection. Returns (connection_id, code verifier that was used).
async fn authorize_a_mock_connection(state: &AppState) -> (String, String) {
    let (status, created) = call(
        state,
        "POST",
        "/api/v1/connections",
        Some(json!({"provider_id": "mock", "display_name": "Mock"})),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{created}");
    let connection_id = created["connection_id"].as_str().expect("id").to_string();
    assert_eq!(created["status"], "pending");

    let (status, start) = call(
        state,
        "POST",
        &format!("/api/v1/connections/{connection_id}/authorize"),
        Some(json!({"scopes": ["read", "offline_access"]})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{start}");
    let authorization_url = start["authorization_url"]
        .as_str()
        .expect("url")
        .to_string();
    let oauth_state = start["state"].as_str().expect("state").to_string();
    let verifier = stored_verifier(state, &oauth_state).await;

    // Follow the consent redirect the way a browser would.
    let http = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .expect("client");
    let redirect = http
        .get(&authorization_url)
        .send()
        .await
        .expect("authorize");
    assert_eq!(
        redirect.status().as_u16(),
        302,
        "authorize did not redirect"
    );
    let location = redirect
        .headers()
        .get("location")
        .and_then(|v| v.to_str().ok())
        .expect("location")
        .to_string();
    let callback = url::Url::parse(&location).expect("callback url");
    let query: HashMap<_, _> = callback.query_pairs().into_owned().collect();
    assert_eq!(query["state"], oauth_state);

    let (status, page) = send(
        state,
        Request::builder()
            .method("GET")
            .uri(format!(
                "/api/v1/oauth/callback/mock?code={}&state={}",
                query["code"], query["state"]
            ))
            .body(Body::empty())
            .expect("request"),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{page}");
    assert!(page.contains("opensesame:connection"), "{page}");
    assert!(page.contains(&connection_id), "{page}");
    assert_no_credential_material("callback page", &page, &verifier);

    (connection_id, verifier)
}

// ---- tests ---------------------------------------------------------------------

#[tokio::test]
async fn health_alias_answers() {
    let (state, _server) = harness().await;
    let (status, body) = send(
        &state,
        Request::builder()
            .uri("/api/v1/health")
            .body(Body::empty())
            .expect("request"),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body, "ok");
}

#[tokio::test]
async fn the_whole_loop_from_create_to_revoke() {
    let (state, server) = harness().await;
    let (connection_id, _verifier) = authorize_a_mock_connection(&state).await;

    let (status, active) = call(
        &state,
        "GET",
        &format!("/api/v1/connections/{connection_id}"),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(active["status"], "active");
    assert_eq!(active["refreshable"], true);
    assert!(active["expires_at"].is_string());
    assert_eq!(active["granted_scopes"], json!(["read", "offline_access"]));
    assert!(active["connection_ref"]
        .as_str()
        .expect("ref")
        .starts_with("conn://"));

    let (status, refreshed) = call(
        &state,
        "POST",
        &format!("/api/v1/connections/{connection_id}/refresh"),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{refreshed}");
    assert_eq!(refreshed["status"], "active");
    assert!(refreshed["last_refreshed_at"].is_string());
    assert_eq!(server.refreshes(), 1);

    // Rotation held: the second refresh must present the token the first one returned.
    let (status, refreshed_again) = call(
        &state,
        "POST",
        &format!("/api/v1/connections/{connection_id}/refresh"),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{refreshed_again}");
    assert_eq!(server.refreshes(), 2);

    let (status, revoked) = call(
        &state,
        "DELETE",
        &format!("/api/v1/connections/{connection_id}"),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(revoked["revoked"], true);
    assert_eq!(revoked["provider_revocation"], "unsupported");

    let (_, after) = call(
        &state,
        "GET",
        &format!("/api/v1/connections/{connection_id}"),
        None,
    )
    .await;
    assert_eq!(after["status"], "revoked");

    let kinds: Vec<String> = call(
        &state,
        "GET",
        &format!("/api/v1/connections/{connection_id}/events"),
        None,
    )
    .await
    .1["events"]
        .as_array()
        .expect("events")
        .iter()
        .map(|e| e["kind"].as_str().unwrap_or_default().to_string())
        .collect();
    assert_eq!(
        kinds,
        vec![
            "created",
            "authorize_started",
            "authorized",
            "refreshed",
            "refreshed",
            "revoked"
        ]
    );
}

#[tokio::test]
async fn a_rejected_refresh_asks_for_reauthorization_without_losing_the_connection() {
    let (state, server) = harness().await;
    let (connection_id, _verifier) = authorize_a_mock_connection(&state).await;

    call(
        &state,
        "POST",
        &format!("/api/v1/connections/{connection_id}/bindings"),
        Some(json!({"target_kind":"agent","target_id":"agent:1"})),
    )
    .await;
    server.reject_refresh();

    let (status, body) = call(
        &state,
        "POST",
        &format!("/api/v1/connections/{connection_id}/refresh"),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::BAD_GATEWAY, "{body}");
    assert_eq!(body["error"], "needs_reauth");

    let (_, after) = call(
        &state,
        "GET",
        &format!("/api/v1/connections/{connection_id}"),
        None,
    )
    .await;
    assert_eq!(after["status"], "needs_reauth");
    assert!(after["status_detail"].is_string());
    assert_eq!(after["bindings"].as_array().map(Vec::len), Some(1));
}

/// Every route that can be reached for an active connection, checked against the
/// leak denylist in one pass.
#[tokio::test]
async fn no_route_returns_credential_material() {
    let (state, _server) = harness().await;
    let (connection_id, verifier) = authorize_a_mock_connection(&state).await;

    let (_, bound) = call(
        &state,
        "POST",
        &format!("/api/v1/connections/{connection_id}/bindings"),
        Some(json!({"target_kind":"project","target_id":"project:1","target_label":"catalog"})),
    )
    .await;
    let binding_id = bound["bindings"][0]["id"]
        .as_str()
        .expect("binding")
        .to_string();

    let routes = vec![
        ("GET", "/api/v1/connections".to_string(), None),
        ("GET", format!("/api/v1/connections/{connection_id}"), None),
        (
            "GET",
            format!("/api/v1/connections/{connection_id}/events"),
            None,
        ),
        (
            "POST",
            format!("/api/v1/connections/{connection_id}/refresh"),
            None,
        ),
        (
            "POST",
            format!("/api/v1/connections/{connection_id}/authorize"),
            Some(json!({})),
        ),
        (
            "DELETE",
            format!("/api/v1/connections/{connection_id}/bindings/{binding_id}"),
            None,
        ),
        (
            "DELETE",
            format!("/api/v1/connections/{connection_id}"),
            None,
        ),
    ];
    for (method, uri, body) in routes {
        let (_, value) = call(&state, method, &uri, body).await;
        assert_no_credential_material(&format!("{method} {uri}"), &value.to_string(), &verifier);
    }

    // The catalog is not connection state, but it must not carry a secret either.
    let (_, providers) = call(&state, "GET", "/api/v1/providers", None).await;
    let rendered = providers.to_string();
    for banned in [CLIENT_SECRET, ACCESS_TOKEN_1, REFRESH_TOKEN_1] {
        assert!(!rendered.contains(banned), "providers leaked {banned}");
    }
    assert!(rendered.contains("OPENSESAME_PROVIDER_GITHUB_CLIENT_ID"));
}

#[tokio::test]
async fn provider_route_exposes_fnox_configuration_connectors() {
    let (state, _server) = harness().await;
    let (status, body) = call(&state, "GET", "/api/v1/providers", None).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let providers = body["providers"].as_array().unwrap();
    assert!(providers.iter().any(|provider| provider["id"] == "bitwarden"));
    let azure = providers
        .iter()
        .find(|provider| provider["id"] == "azure-sm")
        .unwrap();
    assert_eq!(azure["auth_kind"], "configuration");
    assert!(azure["connection_configuration_fields"]
        .as_array()
        .unwrap()
        .iter()
        .any(|field| field["name"] == "client_secret" && field["secret"] == true));
}

#[tokio::test]
async fn a_replayed_state_is_refused_at_the_callback() {
    let (state, _server) = harness().await;

    let (_, created) = call(
        &state,
        "POST",
        "/api/v1/connections",
        Some(json!({"provider_id": "mock"})),
    )
    .await;
    let connection_id = created["connection_id"].as_str().expect("id").to_string();
    let (_, start) = call(
        &state,
        "POST",
        &format!("/api/v1/connections/{connection_id}/authorize"),
        None,
    )
    .await;
    let oauth_state = start["state"].as_str().expect("state").to_string();

    let http = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .expect("client");
    http.get(start["authorization_url"].as_str().expect("url"))
        .send()
        .await
        .expect("authorize");

    let uri = format!("/api/v1/oauth/callback/mock?code={AUTH_CODE}&state={oauth_state}");
    let (first, _) = send(
        &state,
        Request::builder()
            .uri(&uri)
            .body(Body::empty())
            .expect("request"),
    )
    .await;
    assert_eq!(first, StatusCode::OK);

    let (second, page) = send(
        &state,
        Request::builder()
            .uri(&uri)
            .body(Body::empty())
            .expect("request"),
    )
    .await;
    assert_eq!(second, StatusCode::BAD_REQUEST);
    assert!(page.contains("invalid_state"), "{page}");
    // A failure renders legibly rather than as a blank page.
    assert!(page.contains("Connection failed"), "{page}");
}

#[tokio::test]
async fn an_expired_state_is_refused_at_the_callback() {
    let (state, _server) = harness().await;
    let (_, created) = call(
        &state,
        "POST",
        "/api/v1/connections",
        Some(json!({"provider_id": "mock"})),
    )
    .await;
    let connection_id = created["connection_id"].as_str().expect("id").to_string();

    store::insert_authorization(
        state.db.pool(),
        &store::AuthorizationRow {
            state: "expired-state".into(),
            code_verifier: opensesame_connection_broker::crypto::seal(
                &[7_u8; 32],
                &connection_id,
                &state.connection_organization.to_string(),
                b"verifier-that-should-never-be-used",
            )
            .expect("seal verifier fixture"),
            connection_id,
            redirect_uri: "http://127.0.0.1:8787/api/v1/oauth/callback/mock".into(),
            scopes: vec!["read".into()],
            expires_at: chrono::Utc::now() - chrono::Duration::seconds(1),
            credential_version: None,
        },
    )
    .await
    .expect("insert");

    let (status, page) = send(
        &state,
        Request::builder()
            .uri("/api/v1/oauth/callback/mock?code=x&state=expired-state")
            .body(Body::empty())
            .expect("request"),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(page.contains("state_expired"), "{page}");
    assert!(
        !page.contains("verifier-that-should-never-be-used"),
        "{page}"
    );
}

/// The in-test authorization server is only evidence if it actually checks PKCE.
#[tokio::test]
async fn the_authorization_server_rejects_a_wrong_verifier() {
    let (state, server) = harness().await;
    let (_, created) = call(
        &state,
        "POST",
        "/api/v1/connections",
        Some(json!({"provider_id": "mock"})),
    )
    .await;
    let connection_id = created["connection_id"].as_str().expect("id").to_string();
    let (_, start) = call(
        &state,
        "POST",
        &format!("/api/v1/connections/{connection_id}/authorize"),
        None,
    )
    .await;

    let http = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .expect("client");
    http.get(start["authorization_url"].as_str().expect("url"))
        .send()
        .await
        .expect("authorize");

    let response = http
        .post(format!("{}/token", server.base_url))
        .form(&[
            ("grant_type", "authorization_code"),
            ("code", AUTH_CODE),
            ("code_verifier", "not-the-verifier-we-committed-to"),
            (
                "redirect_uri",
                "http://127.0.0.1:8787/api/v1/oauth/callback/mock",
            ),
            ("client_id", CLIENT_ID),
            ("client_secret", CLIENT_SECRET),
        ])
        .send()
        .await
        .expect("token");
    assert_eq!(response.status().as_u16(), 400);
    assert!(response
        .text()
        .await
        .expect("body")
        .contains("invalid_grant"));
}

#[tokio::test]
async fn the_callback_escapes_what_the_provider_sent() {
    let (state, _server) = harness().await;
    let (status, created) = call(
        &state,
        "POST",
        "/api/v1/connections",
        Some(json!({"provider_id": "mock"})),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{created}");
    let (status, started) = call(
        &state,
        "POST",
        &format!(
            "/api/v1/connections/{}/authorize",
            created["connection_id"].as_str().unwrap()
        ),
        Some(json!({})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{started}");
    let oauth_state = started["state"].as_str().unwrap();
    let (status, page) = send(
        &state,
        Request::builder()
            .uri(format!("/api/v1/oauth/callback/mock?state={oauth_state}&error=access_denied&error_description=%3Cscript%3Ealert(1)%3C%2Fscript%3E"))
            .body(Body::empty())
            .expect("request"),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(!page.contains("<script>alert(1)"), "{page}");
    assert!(!page.contains("alert(1)"), "{page}");
    assert!(page.contains("access_denied"), "{page}");
}

#[tokio::test]
async fn the_connections_list_names_only_real_connections() {
    let (mut state, _server) = harness().await;
    let organization = state.connection_organization;
    state.connection_ref = Some(
        opensesame_domain::ConnectionRef::new(
            organization,
            None,
            "github/main",
            opensesame_domain::ConnectionId::new(),
        )
        .expect("ref"),
    );

    // A demo bootstrap ref is deployment state, not a connection: it names no row,
    // so listing it would offer something every other route reports as absent.
    let (status, listed) = call(&state, "GET", "/api/v1/connections", None).await;
    assert_eq!(status, StatusCode::OK);
    assert!(listed["connections"]
        .as_array()
        .expect("connections")
        .is_empty());

    call(
        &state,
        "POST",
        "/api/v1/connections",
        Some(json!({"provider_id": "mock"})),
    )
    .await;

    let (_, listed) = call(&state, "GET", "/api/v1/connections", None).await;
    let connections = listed["connections"].as_array().expect("connections");
    assert_eq!(connections.len(), 1);
    for connection in connections {
        let id = connection["connection_id"].as_str().expect("id");
        assert!(connection["connection_ref"]
            .as_str()
            .expect("ref")
            .starts_with("conn://"));
        // Listed means reachable: anything named here can be opened.
        let (status, _) = call(&state, "GET", &format!("/api/v1/connections/{id}"), None).await;
        assert_eq!(status, StatusCode::OK);
    }
}

#[tokio::test]
async fn connection_routes_require_a_caller() {
    let (state, _server) = harness().await;
    for (method, uri) in [
        ("GET", "/api/v1/connections"),
        ("GET", "/api/v1/providers"),
        ("POST", "/api/v1/connections"),
        ("GET", "/api/v1/connections/connection:1/events"),
    ] {
        let (status, _) = send(
            &state,
            Request::builder()
                .method(method)
                .uri(uri)
                .body(Body::empty())
                .expect("request"),
        )
        .await;
        assert_eq!(status, StatusCode::UNAUTHORIZED, "{method} {uri}");
    }
}

#[tokio::test]
async fn unknown_ids_and_providers_answer_in_contract_codes() {
    let (state, _server) = harness().await;
    let (status, body) = call(
        &state,
        "POST",
        "/api/v1/connections",
        Some(json!({"provider_id": "myspace"})),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body["error"], "provider_unknown");
    assert!(body["hint"].is_string());

    let (status, body) = call(&state, "GET", "/api/v1/connections/connection:0", None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(body["error"], "connection_not_found");

    let (status, body) = call(
        &state,
        "POST",
        "/api/v1/connections",
        Some(json!({"provider_id": "github"})),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(body["error"], "integration_not_found");
}

/// A session mint, straight into state: device approval is exercised elsewhere and
/// what matters here is the subject the session acts as.
fn session(state: &AppState, subject: &str) -> String {
    session_for(
        state,
        subject,
        state.connection_organization,
        opensesame_domain::OrganizationRole::Member,
    )
}

fn session_for(
    state: &AppState,
    subject: &str,
    organization_id: opensesame_domain::OrganizationId,
    role: opensesame_domain::OrganizationRole,
) -> String {
    let id = uuid::Uuid::new_v4().to_string();
    state.sessions.lock().expect("lock").insert(
        opensesame_claims::hash_secret(&id),
        json!({
            "approved_as": subject,
            "organization_id": organization_id,
            "organization_role": role,
            "expires_at": (chrono::Utc::now() + chrono::Duration::hours(1)).to_rfc3339(),
        }),
    );
    id
}

async fn as_session(
    state: &AppState,
    session_id: &str,
    method: &str,
    uri: &str,
    body: Option<Value>,
) -> (StatusCode, Value) {
    let mut builder = Request::builder().method(method).uri(uri).header(
        "authorization",
        format!("Bearer opaque-session:{session_id}"),
    );
    let body = match body {
        Some(v) => {
            builder = builder.header("content-type", "application/json");
            Body::from(v.to_string())
        }
        None => Body::empty(),
    };
    let (status, raw) = send(state, builder.body(body).expect("request")).await;
    let parsed = serde_json::from_str(&raw).unwrap_or(Value::String(raw));
    (status, parsed)
}

#[tokio::test]
async fn integration_routes_enforce_org_roles_and_allow_member_use() {
    let (state, _server) = harness().await;
    let org = state.connection_organization;
    let member = session_for(
        &state,
        "user:member",
        org,
        opensesame_domain::OrganizationRole::Member,
    );
    let owner = session_for(
        &state,
        "user:owner",
        org,
        opensesame_domain::OrganizationRole::Owner,
    );
    let admin = session_for(
        &state,
        "user:admin",
        org,
        opensesame_domain::OrganizationRole::Admin,
    );

    assert_eq!(
        as_session(&state, &member, "GET", "/api/v1/integrations", None)
            .await
            .0,
        StatusCode::OK
    );
    assert_eq!(
        as_session(
            &state,
            &member,
            "POST",
            "/api/v1/integrations",
            Some(json!({"key":"denied","provider_id":"mock","display_name":"Denied"})),
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    let (status, integration) = as_session(
        &state,
        &owner,
        "POST",
        "/api/v1/integrations",
        Some(json!({
            "key":"team-mock",
            "provider_id":"mock",
            "display_name":"Team mock",
            "scopes":["read"],
            "client_id":CLIENT_ID,
            "client_secret":CLIENT_SECRET
        })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    let integration_id = integration["id"].as_str().unwrap();

    let (status, body) = as_session(
        &state,
        &admin,
        "PATCH",
        &format!("/api/v1/integrations/{integration_id}"),
        Some(json!({"provider_id":"github"})),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");

    let (status, connection) = as_session(
        &state,
        &member,
        "POST",
        "/api/v1/connections",
        Some(json!({"integration_id":integration_id})),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    let connection_id = connection["connection_id"].as_str().unwrap();
    assert_eq!(
        as_session(
            &state,
            &member,
            "GET",
            &format!("/api/v1/connections/{connection_id}"),
            None,
        )
        .await
        .0,
        StatusCode::OK
    );
    let (status, disposable) = as_session(
        &state,
        &owner,
        "POST",
        "/api/v1/integrations",
        Some(json!({
            "key":"disposable",
            "provider_id":"mock",
            "display_name":"Disposable",
            "scopes":["read"],
            "client_id":CLIENT_ID,
            "client_secret":CLIENT_SECRET
        })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{disposable}");
    assert_eq!(
        as_session(
            &state,
            &admin,
            "DELETE",
            &format!(
                "/api/v1/integrations/{}",
                disposable["id"].as_str().unwrap()
            ),
            None,
        )
        .await
        .0,
        StatusCode::NO_CONTENT
    );
    for method in ["PATCH", "DELETE"] {
        assert_eq!(
            as_session(
                &state,
                &member,
                method,
                &format!("/api/v1/integrations/{integration_id}"),
                (method == "PATCH").then(|| json!({"display_name":"No"})),
            )
            .await
            .0,
            StatusCode::FORBIDDEN
        );
    }
    assert_eq!(
        as_session(
            &state,
            &admin,
            "PATCH",
            &format!("/api/v1/integrations/{integration_id}"),
            Some(json!({"display_name":"Team mock 2"})),
        )
        .await
        .0,
        StatusCode::OK
    );
    let other_org = session_for(
        &state,
        "user:other",
        opensesame_domain::OrganizationId::new(),
        opensesame_domain::OrganizationRole::Member,
    );
    assert_eq!(
        as_session(
            &state,
            &other_org,
            "GET",
            &format!("/api/v1/integrations/{integration_id}"),
            None,
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
}

/// One gateway serves many callers out of one organization, so a valid session is
/// not on its own a claim to every connection in it: another session's grant is
/// not there to be listed, read, re-keyed or revoked.
#[tokio::test]
async fn a_session_cannot_reach_another_sessions_connection() {
    let (state, _server) = harness().await;
    let alice = session(&state, "user:alice");
    let bob = session(&state, "user:bob");

    let (status, created) = as_session(
        &state,
        &alice,
        "POST",
        "/api/v1/connections",
        Some(json!({"provider_id": "mock"})),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{created}");
    let id = created["connection_id"].as_str().expect("id").to_string();

    // Alice sees her own.
    let (status, mine) = as_session(&state, &alice, "GET", "/api/v1/connections", None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(mine["connections"].as_array().expect("array").len(), 1);

    // Bob sees none of it, and cannot name it either.
    let (status, theirs) = as_session(&state, &bob, "GET", "/api/v1/connections", None).await;
    assert_eq!(status, StatusCode::OK);
    assert!(theirs["connections"].as_array().expect("array").is_empty());
    for (method, uri, body) in [
        ("GET", format!("/api/v1/connections/{id}"), None),
        ("GET", format!("/api/v1/connections/{id}/events"), None),
        (
            "POST",
            format!("/api/v1/connections/{id}/authorize"),
            Some(json!({})),
        ),
        (
            "POST",
            format!("/api/v1/connections/{id}/credential"),
            Some(json!({"value": "sk_test_theirs"})),
        ),
        ("POST", format!("/api/v1/connections/{id}/refresh"), None),
        ("DELETE", format!("/api/v1/connections/{id}"), None),
    ] {
        let (status, body) = as_session(&state, &bob, method, &uri, body).await;
        assert_eq!(
            status,
            StatusCode::NOT_FOUND,
            "{method} {uri} answered {status}: {body}"
        );
    }

    // And none of that touched it: still Alice's, still pending.
    let (status, after) = as_session(
        &state,
        &alice,
        "GET",
        &format!("/api/v1/connections/{id}"),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(after["status"], "pending");
}
