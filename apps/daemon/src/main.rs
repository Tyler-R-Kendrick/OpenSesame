//! OpenSesame host daemon — local session capabilities for WSL/devcontainers/toolbar/PWA.
//! Evolved from credential-agent. Never dumps refresh tokens or WebAuthn material.
//! Listens on TCP (`OPENSESAME_DAEMON_LISTEN`) and optionally Unix socket (`OPENSESAME_AGENT_SOCK`).
//! Mutating routes require `OPENSESAME_OPERATOR_TOKEN` (`X-OpenSesame-Operator`).
#![allow(clippy::result_large_err)] // axum handlers return Response in Err
use axum::{
    extract::State,
    http::{header, HeaderMap, StatusCode},
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
    env,
    sync::{Arc, Mutex},
};
use uuid::Uuid;

const DEV_OPERATOR_TOKEN: &str = "opensesame-dev-operator";

fn constant_time_eq(a: &str, b: &str) -> bool {
    let (aa, bb) = (a.as_bytes(), b.as_bytes());
    if aa.len() != bb.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in aa.iter().zip(bb.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

#[derive(Parser)]
#[command(name = "opensesame-daemon", about = "OpenSesame host daemon")]
struct Args {
    #[arg(
        long,
        env = "OPENSESAME_DAEMON_LISTEN",
        default_value = opensesame_host_core::daemon::DEFAULT_LISTEN
    )]
    listen: String,
    /// Optional Unix domain socket (WSL/devcontainer). Env: OPENSESAME_AGENT_SOCK.
    #[arg(long, env = "OPENSESAME_AGENT_SOCK")]
    sock: Option<String>,
    /// Host API base for toolbar approve forwarding.
    #[arg(
        long,
        env = "OPENSESAME_SERVER",
        default_value = "http://127.0.0.1:8787"
    )]
    host_api: String,
    /// Identity API base for claim helpers.
    #[arg(
        long,
        env = "OPENSESAME_ISSUER",
        default_value = "http://127.0.0.1:8788"
    )]
    identity_api: String,
}

#[derive(Clone)]
struct App {
    sessions: Arc<Mutex<HashMap<String, HostSession>>>,
    capabilities: Arc<Mutex<HashMap<String, SessionCapability>>>,
    host_api: String,
    identity_api: String,
    http: reqwest::Client,
    operator_token: String,
}

#[derive(Clone, Debug)]
struct HostSession {
    id: String,
    principal: String,
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
}

#[derive(Deserialize)]
struct ApproveDeviceReq {
    user_code: String,
    #[serde(default)]
    principal: Option<String>,
}

#[derive(Deserialize)]
struct ApproveClaimReq {
    claim_id: String,
    #[serde(default)]
    access_token: Option<String>,
    #[serde(default)]
    claim_token: Option<String>,
}

fn resolve_operator_token() -> String {
    match env::var("OPENSESAME_OPERATOR_TOKEN") {
        Ok(t) if !t.is_empty() => t,
        _ => {
            let prod = env::var("OPENSESAME_ENV").ok().as_deref() == Some("production")
                || env::var("NODE_ENV").ok().as_deref() == Some("production");
            if prod {
                tracing::error!(
                    "OPENSESAME_OPERATOR_TOKEN unset in production — mutating routes will deny"
                );
                String::new()
            } else {
                tracing::warn!(
                    "OPENSESAME_OPERATOR_TOKEN unset; using {DEV_OPERATOR_TOKEN} (dev only)"
                );
                DEV_OPERATOR_TOKEN.into()
            }
        }
    }
}

#[allow(clippy::result_large_err)] // axum::Response is intentionally the Err payload
fn require_operator(st: &App, headers: &HeaderMap) -> Result<(), Response> {
    if st.operator_token.is_empty() {
        return Err((
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({"error":"operator_token_unconfigured"})),
        )
            .into_response());
    }
    let from_header = headers
        .get("x-opensesame-operator")
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);
    let from_bearer = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|a| {
            a.strip_prefix("Bearer operator:")
                .or_else(|| a.strip_prefix("bearer operator:"))
                .map(str::to_string)
        });
    match from_header.or(from_bearer) {
        Some(t) if constant_time_eq(&t, &st.operator_token) => Ok(()),
        _ => Err((
            StatusCode::UNAUTHORIZED,
            Json(json!({
                "error":"operator_unauthorized",
                "hint":"X-OpenSesame-Operator or Bearer operator:<token> required"
            })),
        )
            .into_response()),
    }
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt().init();
    let args = Args::parse();
    let listen = env::var("OPENSESAME_DAEMON_LISTEN")
        .or_else(|_| env::var("OPENSESAME_AGENT_LISTEN"))
        .unwrap_or_else(|_| args.listen.clone());
    let sock = args.sock.or_else(|| env::var("OPENSESAME_AGENT_SOCK").ok());

    let mut sessions = HashMap::new();
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
        host_api: args.host_api.trim_end_matches('/').to_string(),
        identity_api: args.identity_api.trim_end_matches('/').to_string(),
        http: reqwest::Client::new(),
        operator_token: resolve_operator_token(),
    };
    let app = Router::new()
        .route(
            "/health",
            get(|| async {
                Json(json!({
                    "status":"ok",
                    "service":"opensesame-daemon",
                    "uds": env::var("OPENSESAME_AGENT_SOCK").ok(),
                }))
            }),
        )
        .route("/v1/list_sessions", post(list_sessions))
        .route("/v1/get_access_token", post(get_access_token))
        .route("/v1/mint_capability", post(mint_capability))
        .route("/v1/introspect_capability", post(introspect_capability))
        .route("/v1/revoke", post(revoke))
        .route("/v1/toolbar/status", get(toolbar_status))
        .route("/v1/toolbar/approve_device", post(approve_device))
        .route("/v1/toolbar/approve_claim", post(approve_claim))
        .route("/v1/operator/invoke_l1", post(operator_invoke_l1))
        .with_state(state);

    let uds_only = opensesame_host_core::daemon::uds_only_requested();
    tracing::info!(
        %listen,
        sock = ?sock,
        uds_only,
        wit = opensesame_host_core::wit_contract::PACKAGE,
        "daemon starting"
    );

    #[cfg(unix)]
    if uds_only {
        let sock_path = sock.ok_or_else(|| {
            anyhow::anyhow!(
                "{}=1 requires {}",
                opensesame_host_core::daemon::ENV_UDS_ONLY,
                "OPENSESAME_AGENT_SOCK"
            )
        })?;
        let _ = std::fs::remove_file(&sock_path);
        if let Some(parent) = std::path::Path::new(&sock_path).parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let uds = tokio::net::UnixListener::bind(&sock_path)?;
        tracing::info!(%sock_path, "daemon UDS-only listening (TCP disabled)");
        axum::serve(uds, app).await?;
        return Ok(());
    }

    #[cfg(not(unix))]
    if uds_only {
        anyhow::bail!(
            "{}=1 is not supported on non-unix platforms",
            opensesame_host_core::daemon::ENV_UDS_ONLY
        );
    }

    opensesame_host_core::daemon::assert_tcp_listen_allowed(&listen)
        .map_err(anyhow::Error::msg)?;

    let app_clone = app.clone();
    let tcp = tokio::net::TcpListener::bind(&listen).await?;

    #[cfg(unix)]
    if let Some(sock_path) = sock.clone() {
        let _ = std::fs::remove_file(&sock_path);
        if let Some(parent) = std::path::Path::new(&sock_path).parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let uds = tokio::net::UnixListener::bind(&sock_path)?;
        tracing::info!(%sock_path, "daemon UDS listening");
        tokio::spawn(async move {
            if let Err(e) = axum::serve(uds, app_clone).await {
                tracing::error!(error = %e, "uds serve failed");
            }
        });
    }

    #[cfg(not(unix))]
    if sock.is_some() {
        tracing::warn!("OPENSESAME_AGENT_SOCK ignored on non-unix platforms");
    }

    tracing::info!(%listen, "daemon TCP listening");
    axum::serve(tcp, app).await?;
    Ok(())
}

async fn toolbar_status(State(st): State<App>, headers: HeaderMap) -> Response {
    if let Err(resp) = require_operator(&st, &headers) {
        return resp;
    }
    let sessions = st.sessions.lock().unwrap().len();
    let caps = st.capabilities.lock().unwrap().len();
    Json(json!({
        "daemon": "ok",
        "sessions": sessions,
        "capabilities": caps,
        "materialize": "denied_by_default",
        "approvals": ["approve_device", "approve_claim"],
        "auth": "operator_token_required_for_mutations"
    }))
    .into_response()
}

async fn approve_device(
    State(st): State<App>,
    headers: HeaderMap,
    Json(req): Json<ApproveDeviceReq>,
) -> Response {
    if let Err(resp) = require_operator(&st, &headers) {
        return resp;
    }
    let url = format!("{}/api/v1/device/approve", st.host_api);
    match st
        .http
        .post(&url)
        .header("x-opensesame-operator", &st.operator_token)
        .json(&json!({
            "user_code": req.user_code,
            "principal": req.principal.unwrap_or_else(|| "user:demo".into()),
        }))
        .send()
        .await
    {
        Ok(resp) => {
            let status = resp.status().as_u16();
            let body = resp.json::<Value>().await.unwrap_or(json!({}));
            Json(json!({"forwarded_to": url, "status": status, "body": body})).into_response()
        }
        Err(e) => Json(json!({
            "error": e.to_string(),
            "hint": "is Host API up on OPENSESAME_SERVER?"
        }))
        .into_response(),
    }
}

async fn approve_claim(
    State(st): State<App>,
    headers: HeaderMap,
    Json(req): Json<ApproveClaimReq>,
) -> Response {
    if let Err(resp) = require_operator(&st, &headers) {
        return resp;
    }
    // Prefer Host API agent-claim complete (operator + claim_token). Fallback: Identity API.
    if let Some(claim_token) = req.claim_token {
        let url = format!(
            "{}/api/v1/agent-claims/{}/complete",
            st.host_api, req.claim_id
        );
        return match st
            .http
            .post(&url)
            .header("x-opensesame-operator", &st.operator_token)
            .json(&json!({"claim_token": claim_token}))
            .send()
            .await
        {
            Ok(resp) => {
                let status = resp.status().as_u16();
                let body = resp.text().await.unwrap_or_default();
                Json(json!({"forwarded_to": url, "status": status, "body": body})).into_response()
            }
            Err(e) => Json(json!({"error": e.to_string()})).into_response(),
        };
    }
    let url = format!("{}/v1/claims/{}/complete", st.identity_api, req.claim_id);
    let mut builder = st.http.post(&url).json(&json!({}));
    if let Some(tok) = req.access_token {
        builder = builder.bearer_auth(tok);
    }
    match builder.send().await {
        Ok(resp) => {
            let status = resp.status().as_u16();
            let body = resp.text().await.unwrap_or_default();
            Json(json!({"forwarded_to": url, "status": status, "body": body})).into_response()
        }
        Err(e) => Json(json!({
            "error": e.to_string(),
            "hint": "claim complete requires authenticated Identity API session or claim_token"
        }))
        .into_response(),
    }
}

/// Policy-gated operator L1 invoke via Host API (never materialize).
async fn operator_invoke_l1(
    State(st): State<App>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    if let Err(resp) = require_operator(&st, &headers) {
        return resp;
    }
    let level = body
        .get("invoke_level")
        .and_then(|v| v.as_u64())
        .unwrap_or(1);
    if level >= 3 {
        return Json(json!({"error":"materialize_denied","invoke_level": level})).into_response();
    }
    let url = format!("{}/api/v1/intents", st.host_api);
    match st
        .http
        .post(&url)
        .header("x-opensesame-operator", &st.operator_token)
        .json(&body)
        .send()
        .await
    {
        Ok(resp) => {
            let status = resp.status().as_u16();
            let body = resp.json::<Value>().await.unwrap_or(json!({}));
            Json(json!({"status": status, "body": body, "materialize": false})).into_response()
        }
        Err(e) => Json(json!({"error": e.to_string()})).into_response(),
    }
}

async fn list_sessions(State(st): State<App>, headers: HeaderMap) -> Response {
    if let Err(resp) = require_operator(&st, &headers) {
        return resp;
    }
    let sessions: Vec<_> = st
        .sessions
        .lock()
        .unwrap()
        .values()
        .map(|s| json!({"id": s.id, "principal": s.principal}))
        .collect();
    Json(json!({"sessions": sessions})).into_response()
}

async fn get_access_token(Json(_v): Json<Value>) -> Json<Value> {
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
    let sessions = st.sessions.lock().unwrap();
    let Some(session) = sessions.values().next() else {
        return Json(json!({"error":"no_session","hint":"use opensesame login on host"}))
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
    st.capabilities
        .lock()
        .unwrap()
        .insert(cap.id.clone(), cap.clone());
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
    let caps = st.capabilities.lock().unwrap();
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
        st.capabilities.lock().unwrap().remove(id);
    }
    Json(json!({"ok": true})).into_response()
}
