//! OpenSesame host daemon — local session capabilities for WSL/devcontainers/toolbar/PWA.
//! Evolved from credential-agent. Never dumps refresh tokens or WebAuthn material.
//! Listens on TCP (`OPENSESAME_DAEMON_LISTEN`) and optionally Unix socket (`OPENSESAME_AGENT_SOCK`).
//! Mutating routes require `OPENSESAME_OPERATOR_TOKEN` (`X-OpenSesame-Operator`).
#![allow(clippy::result_large_err)] // axum handlers return Response in Err
use axum::{
    body::Bytes,
    extract::{Request, State},
    http::{HeaderMap, HeaderName, StatusCode},
    response::{IntoResponse, Response},
    routing::{any, get, post},
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

mod discovery;
mod tailscale;

const DEV_OPERATOR_TOKEN: &str = "opensesame-dev-operator";

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
    /// Bind the capability to this host session when more than one exists.
    #[serde(default)]
    session_id: Option<String>,
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
    /// User code shown by the device — required by the Identity API fallback.
    #[serde(default)]
    user_code: Option<String>,
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

/// A forward that carries the operator token, refused when the target is not on
/// this machine.
///
/// The token is a shared secret for this host. `OPENSESAME_SERVER` is
/// configuration, so a remote value would hand it to whoever answers there —
/// over cleartext, at that. Deny the forward instead: nothing about being unable
/// to reach a remote Host API justifies giving away the local secret.
#[allow(clippy::result_large_err)]
fn operator_forward(st: &App, url: &str) -> Result<reqwest::RequestBuilder, Response> {
    if !opensesame_host_core::daemon::base_url_is_local(&st.host_api) {
        return Err((
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({
                "error": "remote_host_api",
                "hint": "the operator token is local to this machine; \
                         point OPENSESAME_SERVER at loopback to forward"
            })),
        )
            .into_response());
    }
    Ok(st
        .http
        .post(url)
        .header("x-opensesame-operator", &st.operator_token))
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
    let host_api = args.host_api.trim_end_matches('/').to_string();
    let hsts = host_api.starts_with("https://");
    let http = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(5))
        .connect_timeout(std::time::Duration::from_secs(2))
        .build()?;
    let state = App {
        sessions: Arc::new(Mutex::new(sessions)),
        capabilities: Arc::new(Mutex::new(HashMap::new())),
        host_api,
        identity_api: args.identity_api.trim_end_matches('/').to_string(),
        http,
        operator_token: resolve_operator_token(),
    };
    let app = router(state);

    let cors_origins = opensesame_host_core::http_security::cors_origins_from_env();
    let is_production = std::env::var("OPENSESAME_ENV").ok().as_deref() == Some("production")
        || std::env::var("NODE_ENV").ok().as_deref() == Some("production");
    opensesame_host_core::http_security::assert_cors_origins_allowed(&cors_origins, is_production)
        .map_err(anyhow::Error::msg)?;
    let app = opensesame_host_core::http_security::apply_http_security(app, &cors_origins, hsts);

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

    opensesame_host_core::daemon::assert_tcp_listen_allowed(&listen).map_err(anyhow::Error::msg)?;

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
    let tcp_app = app.clone();
    let tcp_handle = tokio::spawn(async move {
        if let Err(e) = axum::serve(tcp, tcp_app).await {
            tracing::error!(error = %e, "tcp serve failed");
        }
    });
    // Accept before Windows loopback probes / Tailscale Serve target selection.
    tokio::task::yield_now().await;
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;

    // When Windows cannot reach WSL via 127.0.0.1, Serve targets the eth IP —
    // bind that address so the proxy has somewhere to dial.
    if let Some(port) = tailscale::listen_port(&listen) {
        if let Some(bridge) = tailscale::wsl_bridge_listen(port) {
            if bridge != listen {
                let bridge_app = app.clone();
                match tokio::net::TcpListener::bind(&bridge).await {
                    Ok(bridge_tcp) => {
                        tracing::info!(
                            %bridge,
                            "daemon TCP listening (WSL↔Windows Tailscale bridge)"
                        );
                        tokio::spawn(async move {
                            if let Err(e) = axum::serve(bridge_tcp, bridge_app).await {
                                tracing::error!(error = %e, "wsl bridge serve failed");
                            }
                        });
                    }
                    Err(e) => tracing::warn!(
                        %bridge,
                        error = %e,
                        "failed to bind WSL Tailscale bridge listen"
                    ),
                }
            }
        }
    }

    let serve_listen = listen.clone();
    tokio::task::spawn_blocking(move || match tailscale::enable_serve(&serve_listen) {
        Ok(info) => tracing::info!(
            dns = ?info.dns_name,
            url = ?info.https_url,
            cli = ?info.cli_path,
            "tailscale serve passthrough enabled"
        ),
        Err(error) => tracing::warn!(%error, "tailscale serve not enabled"),
    });
    tcp_handle.await?;
    Ok(())
}

async fn daemon_health() -> Json<Value> {
    // Unauthenticated liveness. The public Serve URL is the pairing address;
    // node IPs, DNS, CLI path, and admin enable URLs stay on /v1/toolbar/status.
    let ts = tailscale::info();
    let tailscale_url = ts.https_url.as_deref().and_then(|url| {
        let trimmed = url.trim_end_matches('/');
        (!trimmed.is_empty()).then_some(trimmed)
    });
    Json(json!({
        "status": "ok",
        "service": "opensesame-daemon",
        "tailscale_url": tailscale_url,
    }))
}

fn pairing_view(st: &App) -> Value {
    let ts = tailscale::info();
    let public = ts.https_url.as_deref().and_then(|url| {
        let trimmed = url.trim_end_matches('/');
        (!trimmed.is_empty()).then_some(trimmed)
    });
    json!({
        "host_api": public.map(|url| format!("{url}/host")).unwrap_or_else(|| st.host_api.clone()),
        "identity_api": public.map(|url| format!("{url}/identity")).unwrap_or_else(|| st.identity_api.clone()),
        "tailscale_url": public,
        "tailscale_serve": ts.serve_enabled,
    })
}

async fn proxy_host(State(st): State<App>, req: Request) -> Response {
    let base = st.host_api.clone();
    proxy_loopback(&st, &base, "/host", req).await
}

async fn proxy_identity(State(st): State<App>, req: Request) -> Response {
    let base = st.identity_api.clone();
    proxy_loopback(&st, &base, "/identity", req).await
}

const MAX_PROXY_BODY: usize = 2 * 1024 * 1024;

fn decoded_path_segment(segment: &str) -> Option<String> {
    let bytes = segment.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] != b'%' {
            out.push(bytes[index]);
            index += 1;
            continue;
        }
        let hex = bytes.get(index + 1..index + 3)?;
        let encoded = std::str::from_utf8(hex).ok()?;
        out.push(u8::from_str_radix(encoded, 16).ok()?);
        index += 3;
    }
    String::from_utf8(out).ok()
}

fn is_local_session_path(path: &str) -> bool {
    path.split('/')
        .filter(|segment| !segment.is_empty())
        .map(decoded_path_segment)
        .collect::<Option<Vec<_>>>()
        .as_deref()
        == Some(&["api".into(), "v1".into(), "session".into(), "local".into()])
}

async fn proxy_loopback(st: &App, base: &str, prefix: &str, req: Request) -> Response {
    let path = req.uri().path();
    let rest = path.strip_prefix(prefix).unwrap_or(path);
    if prefix == "/host" && is_local_session_path(rest) {
        return StatusCode::FORBIDDEN.into_response();
    }
    if rest.contains("..") {
        return StatusCode::BAD_REQUEST.into_response();
    }
    let query = req
        .uri()
        .query()
        .map(|q| format!("?{q}"))
        .unwrap_or_default();
    let url = format!("{}{}{}", base.trim_end_matches('/'), rest, query);
    let method = req.method().clone();
    let headers = req.headers().clone();
    let body = match axum::body::to_bytes(req.into_body(), MAX_PROXY_BODY).await {
        Ok(bytes) => bytes,
        Err(_) => return StatusCode::PAYLOAD_TOO_LARGE.into_response(),
    };
    let mut forward = st.http.request(
        reqwest::Method::from_bytes(method.as_str().as_bytes()).unwrap_or(reqwest::Method::GET),
        &url,
    );
    for (name, value) in headers.iter() {
        if skip_hop_header(name) {
            continue;
        }
        if let (Ok(n), Ok(v)) = (
            reqwest::header::HeaderName::from_bytes(name.as_str().as_bytes()),
            reqwest::header::HeaderValue::from_bytes(value.as_bytes()),
        ) {
            forward = forward.header(n, v);
        }
    }
    match forward.body(body.to_vec()).send().await {
        Ok(upstream) => {
            if upstream
                .content_length()
                .is_some_and(|len| len > MAX_PROXY_BODY as u64)
            {
                return StatusCode::PAYLOAD_TOO_LARGE.into_response();
            }
            let status =
                StatusCode::from_u16(upstream.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
            let mut response = Response::builder().status(status);
            for (name, value) in upstream.headers() {
                if let (Ok(n), Ok(v)) = (
                    HeaderName::from_bytes(name.as_str().as_bytes()),
                    axum::http::HeaderValue::from_bytes(value.as_bytes()),
                ) {
                    if !skip_hop_header(&n) {
                        response = response.header(n, v);
                    }
                }
            }
            let bytes = upstream.bytes().await.unwrap_or_else(|_| Bytes::new());
            if bytes.len() > MAX_PROXY_BODY {
                return StatusCode::PAYLOAD_TOO_LARGE.into_response();
            }
            response
                .body(axum::body::Body::from(bytes))
                .unwrap_or_else(|_| StatusCode::BAD_GATEWAY.into_response())
        }
        Err(_) => (
            StatusCode::BAD_GATEWAY,
            Json(json!({"error": "upstream_unreachable"})),
        )
            .into_response(),
    }
}

fn router(state: App) -> Router {
    Router::new()
        .route("/health", get(daemon_health))
        .route("/v1/list_sessions", post(list_sessions))
        .route("/v1/get_access_token", post(get_access_token))
        .route("/v1/mint_capability", post(mint_capability))
        .route("/v1/introspect_capability", post(introspect_capability))
        .route("/v1/revoke", post(revoke))
        .route("/v1/discover", post(discover))
        .route("/v1/toolbar/status", get(toolbar_status))
        .route("/v1/toolbar/approve_device", post(approve_device))
        .route("/v1/toolbar/approve_claim", post(approve_claim))
        .route("/v1/operator/invoke_l1", post(operator_invoke_l1))
        .route("/host", any(proxy_host))
        .route("/host/{*path}", any(proxy_host))
        .route("/identity", any(proxy_identity))
        .route("/identity/{*path}", any(proxy_identity))
        .with_state(state)
}

fn skip_hop_header(name: &HeaderName) -> bool {
    opensesame_host_core::http_security::is_hop_or_forwarding_header(name.as_str())
}

/// Report which connectors look configured on this machine (ADR 0047).
///
/// Operator-gated even though it mutates nothing: the threat here is
/// disclosure, not modification, and a list of which credentials a machine
/// holds is a more valuable target than the capability minting beside it.
async fn discover(State(st): State<App>, headers: HeaderMap) -> Response {
    if let Err(resp) = require_operator(&st, &headers) {
        return resp;
    }
    Json(discovery::report()).into_response()
}

async fn toolbar_status(State(st): State<App>, headers: HeaderMap) -> Response {
    if let Err(resp) = require_operator(&st, &headers) {
        return resp;
    }
    let sessions = match st.sessions.lock() {
        Ok(guard) => guard.len(),
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };
    let caps = match st.capabilities.lock() {
        Ok(guard) => guard.len(),
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };
    let mut body = pairing_view(&st);
    if let Some(obj) = body.as_object_mut() {
        obj.insert("daemon".into(), json!("ok"));
        obj.insert("sessions".into(), json!(sessions));
        obj.insert("capabilities".into(), json!(caps));
        obj.insert("materialize".into(), json!("denied_by_default"));
        obj.insert(
            "approvals".into(),
            json!(["approve_device", "approve_claim"]),
        );
        obj.insert(
            "auth".into(),
            json!("operator_token_required_for_mutations"),
        );
    }
    Json(body).into_response()
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
    let forward = match operator_forward(&st, &url) {
        Ok(f) => f,
        Err(resp) => return resp,
    };
    match forward
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
    if !opensesame_host_core::http_security::is_safe_path_id(&req.claim_id) {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error": "invalid_claim_id"})),
        )
            .into_response();
    }
    let Some(user_code) = req.user_code.clone() else {
        return Json(json!({
            "error": "user_code_required",
            "hint": "claim complete requires the user code shown by the device"
        }))
        .into_response();
    };
    let claim_id = &req.claim_id;
    if let Some(claim_token) = req.claim_token {
        let url = format!("{}/api/v1/agent-claims/{}/complete", st.host_api, claim_id);
        let forward = match operator_forward(&st, &url) {
            Ok(f) => f,
            Err(resp) => return resp,
        };
        return match forward
            .json(&json!({"claim_token": claim_token, "user_code": user_code}))
            .send()
            .await
        {
            Ok(resp) => {
                let status = resp.status().as_u16();
                Json(json!({"status": status})).into_response()
            }
            Err(_) => Json(json!({"error": "upstream_unreachable"})).into_response(),
        };
    }
    if !opensesame_host_core::daemon::base_url_is_local(&st.identity_api) {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({
                "error": "remote_identity_api",
                "hint": "point OPENSESAME_ISSUER at loopback to complete claims"
            })),
        )
            .into_response();
    }
    let url = format!("{}/v1/claims/{}/complete", st.identity_api, claim_id);
    let mut builder = st
        .http
        .post(&url)
        .json(&json!({"acceptedItemIds": [], "userCode": user_code}));
    if let Some(tok) = req.access_token {
        builder = builder.bearer_auth(tok);
    }
    match builder.send().await {
        Ok(resp) => {
            let status = resp.status().as_u16();
            Json(json!({"status": status})).into_response()
        }
        Err(_) => Json(json!({
            "error": "upstream_unreachable",
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
    // A task-bound caller must execute the intent it froze: forward the digest to
    // the fenced route instead of re-describing the call on the legacy path,
    // which would spend no ceiling.
    let digest = body
        .get("intent_digest")
        .and_then(|v| v.as_str())
        .map(str::to_owned)
        .or_else(|| {
            headers
                .get("x-opensesame-intent-digest")
                .and_then(|v| v.to_str().ok())
                .map(str::to_owned)
        });
    let (url, forwarded) = match &digest {
        Some(d) => (
            format!("{}/api/v1/tasks/invoke", st.host_api),
            json!({"intent_digest": d}),
        ),
        None => (format!("{}/api/v1/intents", st.host_api), body),
    };
    let forward = match operator_forward(&st, &url) {
        Ok(f) => f,
        Err(resp) => return resp,
    };
    match forward.json(&forwarded).send().await {
        Ok(resp) => {
            let status = resp.status().as_u16();
            let body = resp.json::<Value>().await.unwrap_or(json!({}));
            Json(json!({
                "status": status,
                "body": body,
                "materialize": false,
                "task_bound": digest.is_some(),
            }))
            .into_response()
        }
        // The transport error carries the Host API address.
        Err(e) => {
            tracing::warn!(error = %e, "host api invoke failed");
            Json(json!({"error": "host_api_unreachable"})).into_response()
        }
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
    let sessions = match st.sessions.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };
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
        // An expired capability is already inert on introspect; keeping it only
        // grows the daemon for as long as it runs.
        let mut caps = st.capabilities.lock().unwrap();
        let now = Utc::now();
        caps.retain(|_, c| c.expires_at > now);
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hop_headers_include_forwarding_spoof_set() {
        for name in [
            "x-forwarded-for",
            "X-Forwarded-Host",
            "forwarded",
            "x-real-ip",
        ] {
            assert!(
                opensesame_host_core::http_security::is_hop_or_forwarding_header(name),
                "{name}"
            );
        }
    }

    #[test]
    fn claim_ids_reject_path_and_query_injection() {
        use opensesame_host_core::http_security::is_safe_path_id;
        assert!(is_safe_path_id("clm_abc12345"));
        assert!(!is_safe_path_id("../complete"));
        assert!(!is_safe_path_id("clm?x=1"));
        assert!(!is_safe_path_id("clm#frag"));
        assert!(!is_safe_path_id("clm/../../admin"));
    }

    #[test]
    fn production_proxy_strips_forwarding_headers_before_upstream() {
        opensesame_host_core::pact::assert_source_order(
            include_str!("main.rs"),
            &["skip_hop_header", "forward.header"],
        );
        let src = include_str!("main.rs");
        assert!(src.contains("is_hop_or_forwarding_header"));
        assert!(src.contains("is_safe_path_id"));
        assert!(src.contains("upstream_unreachable"));
        opensesame_host_core::pact::assert_source_order(
            include_str!("main.rs"),
            &[
                "if rest.contains(\"..\")",
                "BAD_REQUEST",
                "upstream_unreachable",
            ],
        );
    }

    fn test_app(host_api: &str) -> (Router, App) {
        let http = reqwest::Client::builder()
            .timeout(std::time::Duration::from_millis(400))
            .connect_timeout(std::time::Duration::from_millis(200))
            .build()
            .unwrap();
        let state = App {
            sessions: Arc::new(Mutex::new(HashMap::new())),
            capabilities: Arc::new(Mutex::new(HashMap::new())),
            host_api: host_api.to_string(),
            identity_api: "http://127.0.0.1:1".into(),
            http,
            operator_token: DEV_OPERATOR_TOKEN.into(),
        };
        (router(state.clone()), state)
    }

    #[tokio::test]
    async fn proxy_returns_bad_gateway_when_host_is_partitioned() {
        use axum::body::{to_bytes, Body};
        use axum::http::Request;
        use tower::ServiceExt;

        let (app, _) = test_app("http://127.0.0.1:1");
        let req = Request::builder()
            .uri("/host/health")
            .body(Body::empty())
            .unwrap();
        let res = app.oneshot(req).await.unwrap();
        assert_eq!(res.status(), StatusCode::BAD_GATEWAY);
        let body = to_bytes(res.into_body(), 1024).await.unwrap();
        let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(json["error"], "upstream_unreachable");
        assert!(json.get("token").is_none());
        assert!(json.get("operator_token").is_none());
    }

    #[tokio::test]
    async fn proxy_rejects_path_traversal_before_dialing() {
        use axum::body::Body;
        use axum::http::Request;
        use tower::ServiceExt;

        let (app, _) = test_app("http://127.0.0.1:1");
        let req = Request::builder()
            .uri("/host/foo/../secret")
            .body(Body::empty())
            .unwrap();
        let res = app.oneshot(req).await.unwrap();
        assert_eq!(res.status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn proxy_never_forwards_local_session_mint() {
        use axum::body::Body;
        use axum::http::Request;
        use tower::ServiceExt;

        for path in [
            "/host/api/v1/session/local",
            "/host//api/v1/session/local/",
            "/host/api/v1/%73ession/local",
        ] {
            let (app, _) = test_app("http://127.0.0.1:1");
            let res = app
                .oneshot(Request::builder().uri(path).body(Body::empty()).unwrap())
                .await
                .unwrap();
            assert_eq!(res.status(), StatusCode::FORBIDDEN, "{path}");
        }
    }

    #[tokio::test]
    async fn health_is_opaque() {
        use axum::body::{to_bytes, Body};
        use axum::http::Request;
        use tower::ServiceExt;

        let (app, _) = test_app("http://127.0.0.1:8787");
        let req = Request::builder()
            .uri("/health")
            .body(Body::empty())
            .unwrap();
        let res = app.oneshot(req).await.unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        let body = to_bytes(res.into_body(), 1024).await.unwrap();
        let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(json["status"], "ok");
        let text = json.to_string();
        assert!(!text.contains(DEV_OPERATOR_TOKEN));
        assert!(!text.contains("access_token"));
    }

    #[tokio::test]
    async fn adversarial_discovery_is_refused_without_the_operator_token() {
        use axum::body::Body;
        use axum::http::Request;
        use tower::ServiceExt;

        // A co-resident process reaches this port as easily as the toolbar
        // does, and this route names which credentials the machine holds.
        let (app, _) = test_app("http://127.0.0.1:8787");
        let req = Request::builder()
            .method("POST")
            .uri("/v1/discover")
            .body(Body::empty())
            .unwrap();
        let res = app.oneshot(req).await.unwrap();
        assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
    }
}
