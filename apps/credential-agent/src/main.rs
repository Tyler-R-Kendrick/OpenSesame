//! DEPRECATED: use `opensesame-daemon` (apps/daemon). Kept for OPENSESAME_AGENT_LISTEN compat.
//! Host credential agent — issues short-lived session capabilities to WSL/devcontainers.
//! Never dumps refresh tokens or WebAuthn material.
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

#[derive(Clone)]
struct App {
    sessions: Arc<Mutex<HashMap<String, HostSession>>>,
    capabilities: Arc<Mutex<HashMap<String, SessionCapability>>>,
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
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt().init();
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
    };
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
    tracing::info!(%args.listen, "credential-agent listening (session capabilities; no dump_refresh_token)");
    let listener = tokio::net::TcpListener::bind(args.listen).await?;
    axum::serve(listener, app).await?;
    Ok(())
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
    // Never dump refresh tokens — mint a capability instead.
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
