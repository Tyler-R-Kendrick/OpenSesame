//! DEPRECATED: use `opensesame-daemon` (apps/daemon). Kept for OPENSESAME_AGENT_LISTEN compat.
//! Host credential agent — issues short-lived session capabilities to WSL/devcontainers.
//! Never dumps refresh tokens or WebAuthn material.
use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use chrono::{Duration, Utc};
use clap::Parser;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    net::SocketAddr,
    sync::{Arc, Mutex},
};
use uuid::Uuid;

#[derive(Parser)]
struct Args {
    #[arg(
        long,
        env = "OPENSESAME_AGENT_LISTEN",
        default_value = "127.0.0.1:18790"
    )]
    listen: SocketAddr,
}

/// Explicit opt-in for the superseded binary. Without it the process refuses to
/// start, so a stray build cannot quietly offer a second privileged local API.
const ENV_ENABLE_LEGACY: &str = "OPENSESAME_LEGACY_CREDENTIAL_AGENT";

/// Capabilities are pruned on mint; the cap only bounds a burst.
const MAX_CAPABILITIES: usize = 1024;

fn lock_map<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

#[derive(Clone)]
struct App {
    sessions: Arc<Mutex<HashMap<String, HostSession>>>,
    capabilities: Arc<Mutex<HashMap<String, SessionCapability>>>,
    /// Same shared secret the daemon requires — loopback is not a boundary.
    operator_token: String,
}

#[allow(clippy::result_large_err)] // axum::Response is intentionally the Err payload
fn require_operator(st: &App, headers: &HeaderMap) -> Result<(), Response> {
    use opensesame_host_core::operator::{check, OperatorDenial};
    match check(&st.operator_token, headers) {
        Ok(()) => Ok(()),
        Err(OperatorDenial::Unconfigured) => Err((
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({"error":"operator_token_unconfigured"})),
        )
            .into_response()),
        Err(OperatorDenial::Unauthorized) => Err((
            StatusCode::UNAUTHORIZED,
            Json(json!({
                "error":"operator_unauthorized",
                "hint":"X-OpenSesame-Operator or Bearer operator:<token> required"
            })),
        )
            .into_response()),
    }
}

#[derive(Clone, Debug)]
struct HostSession {
    id: String,
    principal: String,
    /// Opaque — never returned via RPC.
    _refresh_sealed: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct SessionCapability {
    id: String,
    session_id: String,
    audience: String,
    expires_at: chrono::DateTime<Utc>,
    scopes: Vec<String>,
}

#[derive(Deserialize)]
struct MintCapReq {
    audience: String,
    #[serde(default)]
    scopes: Vec<String>,
    #[serde(default)]
    session_id: Option<String>,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt().init();
    if std::env::var(ENV_ENABLE_LEGACY).ok().as_deref() != Some("1") {
        anyhow::bail!(
            "opensesame-credential-agent is superseded by opensesame-daemon; set {ENV_ENABLE_LEGACY}=1 to run it anyway"
        );
    }
    let args = Args::parse();
    let mut sessions = HashMap::new();
    // Bootstrap demo host session (real login attaches via vault login on host).
    sessions.insert(
        "host-demo".into(),
        HostSession {
            id: "host-demo".into(),
            principal: "user:demo".into(),
            _refresh_sealed: true,
        },
    );
    let state = App {
        sessions: Arc::new(Mutex::new(sessions)),
        capabilities: Arc::new(Mutex::new(HashMap::new())),
        operator_token: std::env::var("OPENSESAME_OPERATOR_TOKEN").unwrap_or_default(),
    };
    let app = router(state);
    let listen = args.listen.to_string();
    // Same bind fence as opensesame-daemon (legacy binary still ships for compat).
    opensesame_host_core::daemon::assert_tcp_listen_allowed(&listen).map_err(anyhow::Error::msg)?;
    tracing::info!(
        %listen,
        "credential-agent listening (deprecated; prefer opensesame-daemon)"
    );
    let listener = tokio::net::TcpListener::bind(args.listen).await?;
    axum::serve(listener, app).await?;
    Ok(())
}

fn router(state: App) -> Router {
    let app = Router::new()
        .route(
            "/health",
            get(|| async {
                axum::Json(
                    serde_json::json!({"status":"ok","deprecated":true,"use":"opensesame-daemon"}),
                )
            }),
        )
        .route("/v1/list_sessions", post(list_sessions))
        .route("/v1/get_access_token", post(get_access_token))
        .route("/v1/mint_capability", post(mint_capability))
        .route("/v1/introspect_capability", post(introspect_capability))
        .route("/v1/revoke", post(revoke))
        .with_state(state);
    opensesame_host_core::http_security::apply_security_headers(app, false)
}

async fn list_sessions(State(st): State<App>, headers: HeaderMap) -> Response {
    if let Err(resp) = require_operator(&st, &headers) {
        return resp;
    }
    let sessions: Vec<_> = lock_map(&st.sessions)
        .values()
        .map(|s| json!({"id": s.id, "principal": s.principal}))
        .collect();
    Json(json!({"sessions": sessions})).into_response()
}

async fn get_access_token(Json(_v): Json<Value>) -> Json<Value> {
    // Never dump refresh tokens — mint a capability instead.
    Json(json!({
        "error": "use_mint_capability",
        "hint": "POST /v1/mint_capability for a short-lived session capability"
    }))
}

async fn mint_capability(
    State(st): State<App>,
    headers: HeaderMap,
    Json(req): Json<MintCapReq>,
) -> Response {
    if let Err(resp) = require_operator(&st, &headers) {
        return resp;
    }
    let sessions = lock_map(&st.sessions);
    let session = if let Some(id) = req.session_id.as_deref() {
        sessions.get(id)
    } else if sessions.len() == 1 {
        sessions.values().next()
    } else {
        None
    };
    let Some(session) = session else {
        return Json(json!({
            "error":"no_session",
            "hint":"pass session_id from /v1/list_sessions"
        }))
            .into_response();
    };
    let cap = SessionCapability {
        id: format!("cap:{}", Uuid::new_v4()),
        session_id: session.id.clone(),
        audience: req.audience,
        expires_at: Utc::now() + Duration::minutes(30),
        scopes: if req.scopes.is_empty() {
            vec!["opensesame.dev".into(), "opensesame.invoke".into()]
        } else {
            req.scopes
        },
    };
    drop(sessions);
    {
        let mut caps = lock_map(&st.capabilities);
        let now = Utc::now();
        caps.retain(|_, c| c.expires_at > now);
        if caps.len() >= MAX_CAPABILITIES {
            return (
                StatusCode::TOO_MANY_REQUESTS,
                Json(json!({"error":"capability_capacity"})),
            )
                .into_response();
        }
        caps.insert(cap.id.clone(), cap.clone());
    }
    Json(json!({
        "capability": {
            "id": cap.id,
            "audience": cap.audience,
            "expires_at": cap.expires_at,
            "scopes": cap.scopes,
        },
        "refresh_token": null,
        "webauthn_material": null,
        "secrets": null
    }))
    .into_response()
}

async fn introspect_capability(
    State(st): State<App>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    if let Err(resp) = require_operator(&st, &headers) {
        return resp;
    }
    let id = body.get("id").and_then(|v| v.as_str()).unwrap_or("");
    let caps = lock_map(&st.capabilities);
    match caps.get(id) {
        Some(c) if c.expires_at > Utc::now() => Json(json!({
            "active": true,
            "audience": c.audience,
            "scopes": c.scopes,
            "expires_at": c.expires_at
        }))
        .into_response(),
        _ => Json(json!({"active": false})).into_response(),
    }
}

async fn revoke(State(st): State<App>, headers: HeaderMap, Json(body): Json<Value>) -> Response {
    if let Err(resp) = require_operator(&st, &headers) {
        return resp;
    }
    if let Some(id) = body.get("id").and_then(|v| v.as_str()) {
        lock_map(&st.capabilities).remove(id);
    }
    Json(json!({"ok": true})).into_response()
}

#[cfg(test)]
mod pact {
    use super::*;
    use axum::body::{to_bytes, Body};
    use axum::http::{header, Request};
    use tower::ServiceExt;

    const OP: &str = "test-operator-token";

    fn test_app() -> Router {
        let mut sessions = HashMap::new();
        sessions.insert(
            "host-demo".into(),
            HostSession {
                id: "host-demo".into(),
                principal: "user:demo".into(),
                _refresh_sealed: true,
            },
        );
        router(App {
            sessions: Arc::new(Mutex::new(sessions)),
            capabilities: Arc::new(Mutex::new(HashMap::new())),
            operator_token: OP.into(),
        })
    }

    fn operator_req(uri: &str, method: &str, body: Value) -> Request<Body> {
        Request::builder()
            .method(method)
            .uri(uri)
            .header(header::CONTENT_TYPE, "application/json")
            .header("x-opensesame-operator", OP)
            .body(Body::from(body.to_string()))
            .unwrap()
    }

    #[tokio::test]
    async fn property_health_is_opaque() {
        let app = test_app();
        let res = app
            .oneshot(Request::builder().uri("/health").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        let body = to_bytes(res.into_body(), 1024).await.unwrap();
        let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(json["status"], "ok");
        let text = json.to_string();
        assert!(!text.contains(OP));
        assert!(!text.contains("refresh"));
    }

    #[tokio::test]
    async fn adversarial_mint_without_operator_is_401() {
        let app = test_app();
        let req = Request::builder()
            .method("POST")
            .uri("/v1/mint_capability")
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(json!({"audience":"https://api.example"}).to_string()))
            .unwrap();
        let res = app.oneshot(req).await.unwrap();
        assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn chaos_get_access_token_never_dumps_refresh() {
        let app = test_app();
        let req = Request::builder()
            .method("POST")
            .uri("/v1/get_access_token")
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from("{}"))
            .unwrap();
        let res = app.oneshot(req).await.unwrap();
        let body = to_bytes(res.into_body(), 2048).await.unwrap();
        let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(json["error"], "use_mint_capability");
        assert!(json.get("refresh_token").is_none());
        assert!(json.get("access_token").is_none());
    }

    #[tokio::test]
    async fn contract_mint_response_has_null_secrets() {
        let app = test_app();
        let res = app
            .oneshot(operator_req(
                "/v1/mint_capability",
                "POST",
                json!({"audience":"https://api.example"}),
            ))
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        let body = to_bytes(res.into_body(), 4096).await.unwrap();
        let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert!(json["capability"]["id"].as_str().unwrap().starts_with("cap:"));
        assert!(json["refresh_token"].is_null());
        assert!(json["webauthn_material"].is_null());
        assert!(json["secrets"].is_null());
        opensesame_host_core::pact::assert_source_order(
            include_str!("main.rs"),
            &[
                "caps.retain",
                "if caps.len() >= MAX_CAPABILITIES",
                "caps.insert",
            ],
        );
    }
}
