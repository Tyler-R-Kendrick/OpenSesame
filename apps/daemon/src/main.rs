//! OpenSesame host daemon — local session capabilities for WSL/devcontainers/toolbar/PWA.
//! Evolved from credential-agent. Never dumps refresh tokens or WebAuthn material.
//! Listens on TCP (`OPENSESAME_DAEMON_LISTEN`) and optionally Unix socket (`OPENSESAME_AGENT_SOCK`).
use axum::{
    extract::State,
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
    #[arg(long, env = "OPENSESAME_SERVER", default_value = "http://127.0.0.1:8787")]
    host_api: String,
    /// Identity API base for claim helpers.
    #[arg(long, env = "OPENSESAME_ISSUER", default_value = "http://127.0.0.1:8788")]
    identity_api: String,
}

#[derive(Clone)]
struct App {
    sessions: Arc<Mutex<HashMap<String, HostSession>>>,
    capabilities: Arc<Mutex<HashMap<String, SessionCapability>>>,
    host_api: String,
    identity_api: String,
    http: reqwest::Client,
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
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt().init();
    let args = Args::parse();
    let listen = env::var("OPENSESAME_DAEMON_LISTEN")
        .or_else(|_| env::var("OPENSESAME_AGENT_LISTEN"))
        .unwrap_or_else(|_| args.listen.clone());
    let sock = args
        .sock
        .or_else(|| env::var("OPENSESAME_AGENT_SOCK").ok());

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

    tracing::info!(
        %listen,
        sock = ?sock,
        wit = opensesame_host_core::wit_contract::PACKAGE,
        "daemon listening"
    );

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

    axum::serve(tcp, app).await?;
    Ok(())
}

async fn toolbar_status(State(st): State<App>) -> Json<Value> {
    let sessions = st.sessions.lock().unwrap().len();
    let caps = st.capabilities.lock().unwrap().len();
    Json(json!({
        "daemon": "ok",
        "sessions": sessions,
        "capabilities": caps,
        "materialize": "denied_by_default",
        "approvals": ["approve_device", "approve_claim"]
    }))
}

async fn approve_device(State(st): State<App>, Json(req): Json<ApproveDeviceReq>) -> Json<Value> {
    let url = format!("{}/api/v1/device/approve", st.host_api);
    match st
        .http
        .post(&url)
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
            Json(json!({"forwarded_to": url, "status": status, "body": body}))
        }
        Err(e) => Json(json!({"error": e.to_string(), "hint": "is Host API up on OPENSESAME_SERVER?"})),
    }
}

async fn approve_claim(State(st): State<App>, Json(req): Json<ApproveClaimReq>) -> Json<Value> {
    // Identity claim complete — best-effort POST; surfaces path for toolbar.
    let url = format!("{}/v1/claims/{}/complete", st.identity_api, req.claim_id);
    let mut builder = st.http.post(&url).json(&json!({}));
    if let Some(tok) = req.access_token {
        builder = builder.bearer_auth(tok);
    }
    match builder.send().await {
        Ok(resp) => {
            let status = resp.status().as_u16();
            let body = resp.text().await.unwrap_or_default();
            Json(json!({"forwarded_to": url, "status": status, "body": body}))
        }
        Err(e) => Json(json!({
            "error": e.to_string(),
            "hint": "claim complete requires authenticated Identity API session"
        })),
    }
}

/// Policy-gated operator L1 invoke via Host API (never materialize).
async fn operator_invoke_l1(State(st): State<App>, Json(body): Json<Value>) -> Json<Value> {
    let level = body.get("invoke_level").and_then(|v| v.as_u64()).unwrap_or(1);
    if level >= 3 {
        return Json(json!({"error":"materialize_denied","invoke_level": level}));
    }
    let url = format!("{}/api/v1/intents", st.host_api);
    match st.http.post(&url).json(&body).send().await {
        Ok(resp) => {
            let status = resp.status().as_u16();
            let body = resp.json::<Value>().await.unwrap_or(json!({}));
            Json(json!({"status": status, "body": body, "materialize": false}))
        }
        Err(e) => Json(json!({"error": e.to_string()})),
    }
}

async fn list_sessions(State(st): State<App>) -> Json<Value> {
    let sessions: Vec<_> = st
        .sessions
        .lock()
        .unwrap()
        .values()
        .map(|s| json!({"id": s.id, "principal": s.principal}))
        .collect();
    Json(json!({"sessions": sessions}))
}

async fn get_access_token(Json(_v): Json<Value>) -> Json<Value> {
    Json(json!({
        "error": "use_mint_capability",
        "hint": "POST /v1/mint_capability for a short-lived session capability"
    }))
}

async fn mint_capability(State(st): State<App>, Json(req): Json<MintCapReq>) -> Json<Value> {
    let sessions = st.sessions.lock().unwrap();
    let Some(session) = sessions.values().next() else {
        return Json(json!({"error":"no_session","hint":"use opensesame login on host"}));
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
}

async fn introspect_capability(State(st): State<App>, Json(body): Json<Value>) -> Json<Value> {
    let id = body.get("id").and_then(|v| v.as_str()).unwrap_or("");
    let caps = st.capabilities.lock().unwrap();
    match caps.get(id) {
        Some(c) if c.expires_at > Utc::now() => Json(json!({
            "active": true,
            "audience": c.audience,
            "scopes": c.scopes,
            "expires_at": c.expires_at
        })),
        _ => Json(json!({"active": false})),
    }
}

async fn revoke(State(st): State<App>, Json(body): Json<Value>) -> Json<Value> {
    if let Some(id) = body.get("id").and_then(|v| v.as_str()) {
        st.capabilities.lock().unwrap().remove(id);
    }
    Json(json!({"ok": true}))
}
