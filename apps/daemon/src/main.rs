//! OpenSesame host daemon — local session capabilities for WSL/devcontainers/toolbar/PWA.
//! Evolved from credential-agent. Never dumps refresh tokens or WebAuthn material.
//! Listens on TCP (`OPENSESAME_DAEMON_LISTEN`) and optionally Unix socket (`OPENSESAME_AGENT_SOCK`).
//! Mutating routes require `OPENSESAME_OPERATOR_TOKEN` (`X-OpenSesame-Operator`) on TCP;
//! over the Unix socket the kernel-attested peer UID authenticates instead
//! (`OPENSESAME_DAEMON_ALLOWED_UIDS`, default same-user). With `--features
//! tailscale` a read-only tailnet listener authorizes callers by whois identity.
#![allow(clippy::result_large_err)] // axum handlers return Response in Err
use axum::{
    body::Bytes,
    extract::{connect_info::ConnectInfo, DefaultBodyLimit, Request, State},
    http::{header, HeaderMap, HeaderName, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    routing::{any, get, post},
    Extension, Json, Router,
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

mod cli_probe;
mod discovery;
mod invoke_through;
mod keychain;
mod mint;
mod peer_auth;
mod promote;
mod ratelimit;
mod runner;
#[cfg(all(unix, feature = "tailscale"))]
mod tailnet;
mod tailscale;
mod token_source;

use peer_auth::UdsConnectInfo;
use ratelimit::RateKey;

/// Hard cap on a serialized discovery report; oversized reports shed items
/// rather than stream unboundedly (see [`discover_response`]).
const MAX_DISCOVER_RESPONSE_BYTES: usize = 256 * 1024;

/// How a request reached an operator route: over the Unix socket axum inserts
/// `ConnectInfo<UdsConnectInfo>`; over TCP the extension is absent.
type UdsPeer = Option<Extension<ConnectInfo<UdsConnectInfo>>>;

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
    /// Comma-separated UIDs allowed to call operator routes over the Unix
    /// socket. Default: the daemon's own UID (same-user rule).
    #[arg(long, env = "OPENSESAME_DAEMON_ALLOWED_UIDS")]
    allowed_uids: Option<String>,
}

#[derive(Clone)]
struct App {
    sessions: Arc<Mutex<HashMap<String, HostSession>>>,
    capabilities: Arc<Mutex<HashMap<String, SessionCapability>>>,
    host_api: String,
    identity_api: String,
    http: reqwest::Client,
    operator_token: String,
    /// UIDs whose processes may call operator routes over the Unix socket.
    allowed_uids: Vec<u32>,
    discover_limiter: Arc<ratelimit::TokenBucket>,
    /// Promotion is mutating, so it spends from its own bucket rather than the
    /// discovery one (ADR 0048 D4).
    promote_limiter: Arc<ratelimit::TokenBucket>,
    /// Invoke-through brokers live upstream calls; its own strict bucket.
    invoke_limiter: Arc<ratelimit::TokenBucket>,
    /// Helper-driven mints (git/docker per-operation) get a little more
    /// headroom than the one-shot routes, still bounded.
    mint_limiter: Arc<ratelimit::TokenBucket>,
    /// The invoke-through broker (ADR 0048 D6): static egress allowlist,
    /// https only. Tests substitute a loopback-permitting instance.
    invoker: Arc<opensesame_invoke_through::Invoker>,
    /// Builds the per-call credential source for a provider; `None` means no
    /// adapter in v1. A factory (not a stored source) so each call acquires
    /// fresh, off a fresh environment snapshot.
    token_source_factory: TokenSourceFactory,
}

/// How the daemon turns a provider id into its credential source.
type TokenSourceFactory =
    Arc<dyn Fn(&str) -> Option<Box<dyn opensesame_invoke_through::TokenSource>> + Send + Sync>;

/// Production factory: the provider's CLI credential command under the
/// scrubbed runner, over a fresh environment snapshot per call.
fn cli_token_source_factory() -> TokenSourceFactory {
    Arc::new(|provider_id: &str| {
        let env: std::collections::BTreeMap<String, String> = std::env::vars().collect();
        token_source::CliTokenSource::for_provider(provider_id, &env)
            .map(|source| Box::new(source) as Box<dyn opensesame_invoke_through::TokenSource>)
    })
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

/// Authorize an operator-route call.
///
/// Over the Unix socket (`uds_peer` present — axum inserted the connect info)
/// the kernel-attested peer UID is the credential and the bearer token is
/// neither required nor accepted: identity from the platform, not from a
/// presented secret (ADR 0048 §8). An unattested peer fails closed. Over TCP
/// (`uds_peer` absent) the operator bearer token remains the break-glass path.
#[allow(clippy::result_large_err)] // axum::Response is intentionally the Err payload
fn require_operator(st: &App, headers: &HeaderMap, uds_peer: &UdsPeer) -> Result<(), Response> {
    use opensesame_host_core::operator::{check, OperatorDenial};
    if let Some(Extension(ConnectInfo(info))) = uds_peer {
        return match info.0 {
            Some(cred) => match opensesame_uds_authn::authorize(&cred, &st.allowed_uids) {
                Ok(()) => Ok(()),
                Err(error) => Err((
                    StatusCode::UNAUTHORIZED,
                    Json(json!({
                        "error": "uds_peer_unauthorized",
                        "detail": error.to_string(),
                        "hint": "the Unix socket authenticates by peer uid \
                                 (OPENSESAME_DAEMON_ALLOWED_UIDS); \
                                 the operator token is TCP-only"
                    })),
                )
                    .into_response()),
            },
            // The kernel could not attest this caller; deny rather than fall
            // back to a token path that was never meant for the socket.
            None => Err((
                StatusCode::SERVICE_UNAVAILABLE,
                Json(json!({"error": "uds_peer_unattested"})),
            )
                .into_response()),
        };
    }
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
    operator_forward_method(st, reqwest::Method::POST, url)
}

/// [`operator_forward`] for non-POST methods (the promotion handshake lists,
/// creates, and PATCHes connections on the Host API).
#[allow(clippy::result_large_err)]
fn operator_forward_method(
    st: &App,
    method: reqwest::Method,
    url: &str,
) -> Result<reqwest::RequestBuilder, Response> {
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
        .request(method, url)
        .header("x-opensesame-operator", &st.operator_token))
}

/// 429 with a `Retry-After` the caller can actually wait on.
fn rate_limited(retry_after: u64) -> Response {
    let mut response = (
        StatusCode::TOO_MANY_REQUESTS,
        Json(json!({"error": "rate_limited", "retry_after": retry_after})),
    )
        .into_response();
    if let Ok(value) = HeaderValue::from_str(&retry_after.to_string()) {
        response.headers_mut().insert(header::RETRY_AFTER, value);
    }
    response
}

/// Serialize a discovery report under [`MAX_DISCOVER_RESPONSE_BYTES`]. A
/// pathological environment (thousands of offers) sheds items rather than
/// streaming unboundedly, and says so with a top-level `truncated` flag — a
/// shortened list must not present itself as complete. An empty report that
/// still exceeds the cap is a server error, not a silent lie.
fn discover_response(mut report: discovery::DiscoveryReport) -> Response {
    let mut truncated = false;
    loop {
        let mut value = match serde_json::to_value(&report) {
            Ok(value) => value,
            Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
        };
        if truncated {
            if let Some(obj) = value.as_object_mut() {
                obj.insert("truncated".into(), json!(true));
            }
        }
        let body = match serde_json::to_vec(&value) {
            Ok(body) => body,
            Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
        };
        if body.len() <= MAX_DISCOVER_RESPONSE_BYTES {
            return (
                StatusCode::OK,
                [(header::CONTENT_TYPE, "application/json")],
                body,
            )
                .into_response();
        }
        let items = report.report.items.len();
        if items == 0 {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({"error": "report_too_large"})),
            )
                .into_response();
        }
        report.report.items.truncate(items / 2);
        truncated = true;
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
        allowed_uids: peer_auth::allowed_uids(args.allowed_uids.as_deref()),
        discover_limiter: Arc::new(ratelimit::TokenBucket::default()),
        promote_limiter: Arc::new(ratelimit::TokenBucket::default()),
        invoke_limiter: Arc::new(ratelimit::TokenBucket::default()),
        mint_limiter: Arc::new(ratelimit::TokenBucket::new(4.0, 1.0)),
        invoker: Arc::new(opensesame_invoke_through::Invoker::new()),
        token_source_factory: cli_token_source_factory(),
    };
    let app = router(state.clone());

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
        axum::serve(
            uds,
            app.into_make_service_with_connect_info::<UdsConnectInfo>(),
        )
        .await?;
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
        tracing::info!(%sock_path, "daemon UDS listening (peer-credential auth)");
        tokio::spawn(async move {
            if let Err(e) = axum::serve(
                uds,
                app_clone.into_make_service_with_connect_info::<UdsConnectInfo>(),
            )
            .await
            {
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

    // Read-only tailnet listener (ADR 0048 §8, D9): whois identity, no bearer.
    #[cfg(all(unix, feature = "tailscale"))]
    {
        let policy = tailnet::TailnetPolicy::from_env();
        if !policy.allows_anyone() {
            tracing::warn!(
                "tailscale feature on but {}/{} are empty — tailnet listener disabled (fail closed)",
                tailnet::ENV_ALLOW_USERS,
                tailnet::ENV_ALLOW_TAGS
            );
        } else {
            match tailnet::bind_listener(&listen, &policy).await {
                Some(listener) => {
                    let addr = listener.local_addr().ok();
                    tracing::info!(?addr, "daemon tailnet listening (whois auth)");
                    let tailnet_app = tailnet::router(state.clone(), policy);
                    tokio::spawn(async move {
                        if let Err(e) = axum::serve(
                            listener,
                            tailnet_app
                                .into_make_service_with_connect_info::<std::net::SocketAddr>(),
                        )
                        .await
                        {
                            tracing::error!(error = %e, "tailnet serve failed");
                        }
                    });
                }
                None => tracing::warn!("tailnet listener not bound"),
            }
        }
    }

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
        .route(
            "/v1/promote",
            post(promote::promote).layer(DefaultBodyLimit::max(promote::MAX_BODY_BYTES)),
        )
        .route(
            "/v1/invoke_through",
            post(invoke_through::invoke_through)
                .layer(DefaultBodyLimit::max(invoke_through::MAX_BODY_BYTES)),
        )
        .route(
            "/v1/mint",
            post(mint::mint_via_daemon).layer(DefaultBodyLimit::max(mint::MAX_BODY_BYTES)),
        )
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
/// Rate-limited per caller for the same reason: a budget, not a firehose.
async fn discover(State(st): State<App>, uds: UdsPeer, headers: HeaderMap) -> Response {
    if let Err(resp) = require_operator(&st, &headers, &uds) {
        return resp;
    }
    // require_operator passed, so a UDS caller is attested; key by uid there,
    // and share one constant bucket across operator-token callers on TCP.
    let key = match uds.and_then(|Extension(ConnectInfo(info))| info.0) {
        Some(cred) => RateKey::Uid(cred.uid),
        None => RateKey::TcpOperator,
    };
    if let Err(retry_after) = st.discover_limiter.check(key) {
        return rate_limited(retry_after);
    }
    // The probe walk spawns processes and talks to the platform keychain —
    // blocking work, off the async driver threads.
    match tokio::task::spawn_blocking(discovery::report).await {
        Ok(report) => discover_response(report),
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}

async fn toolbar_status(State(st): State<App>, uds: UdsPeer, headers: HeaderMap) -> Response {
    if let Err(resp) = require_operator(&st, &headers, &uds) {
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
    uds: UdsPeer,
    headers: HeaderMap,
    Json(req): Json<ApproveDeviceReq>,
) -> Response {
    if let Err(resp) = require_operator(&st, &headers, &uds) {
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
    uds: UdsPeer,
    headers: HeaderMap,
    Json(req): Json<ApproveClaimReq>,
) -> Response {
    if let Err(resp) = require_operator(&st, &headers, &uds) {
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
    uds: UdsPeer,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    if let Err(resp) = require_operator(&st, &headers, &uds) {
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

async fn list_sessions(State(st): State<App>, uds: UdsPeer, headers: HeaderMap) -> Response {
    if let Err(resp) = require_operator(&st, &headers, &uds) {
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
    uds: UdsPeer,
    headers: HeaderMap,
    Json(req): Json<MintCapReq>,
) -> Response {
    if let Err(resp) = require_operator(&st, &headers, &uds) {
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
    uds: UdsPeer,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    if let Err(resp) = require_operator(&st, &headers, &uds) {
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

async fn revoke(
    State(st): State<App>,
    uds: UdsPeer,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    if let Err(resp) = require_operator(&st, &headers, &uds) {
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

    pub(crate) fn test_state(host_api: &str) -> App {
        let http = reqwest::Client::builder()
            .timeout(std::time::Duration::from_millis(400))
            .connect_timeout(std::time::Duration::from_millis(200))
            .build()
            .unwrap();
        App {
            sessions: Arc::new(Mutex::new(HashMap::new())),
            capabilities: Arc::new(Mutex::new(HashMap::new())),
            host_api: host_api.to_string(),
            identity_api: "http://127.0.0.1:1".into(),
            http,
            operator_token: DEV_OPERATOR_TOKEN.into(),
            allowed_uids: opensesame_uds_authn::default_allowed_uids(),
            discover_limiter: Arc::new(ratelimit::TokenBucket::default()),
            promote_limiter: Arc::new(ratelimit::TokenBucket::default()),
            invoke_limiter: Arc::new(ratelimit::TokenBucket::default()),
            mint_limiter: Arc::new(ratelimit::TokenBucket::default()),
            invoker: Arc::new(opensesame_invoke_through::Invoker::new()),
            token_source_factory: Arc::new(|_| None),
        }
    }

    fn test_app(host_api: &str) -> (Router, App) {
        let state = test_state(host_api);
        (router(state.clone()), state)
    }

    /// Scripted-fault loopback listener shared by the daemon chaos tests —
    /// the same idea as `invoke-through/tests/support/fault.rs`, duplicated
    /// in miniature because a binary crate cannot import another crate's
    /// test support. Deterministic: the test picks the fault, the listener
    /// applies it to every connection, and the accept count is the
    /// fail-closed witness.
    pub(crate) mod fault {
        use std::sync::atomic::{AtomicUsize, Ordering};
        use std::sync::Arc;
        use tokio::task::{JoinHandle, JoinSet};

        /// What the listener does to every connection it accepts.
        #[derive(Debug, Clone, Copy)]
        pub(crate) enum Fault {
            /// Accept, then close immediately — an abrupt reset.
            Reset,
            /// Accept, then never respond; held open until the listener is
            /// dropped, so it outlives any client-side timeout.
            Stall,
        }

        pub(crate) struct FaultListener {
            url: String,
            connections: Arc<AtomicUsize>,
            accept_loop: JoinHandle<()>,
        }

        impl FaultListener {
            pub(crate) async fn spawn(fault: Fault) -> Self {
                let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
                let addr = listener.local_addr().unwrap();
                let connections = Arc::new(AtomicUsize::new(0));
                let counting = connections.clone();
                let accept_loop = tokio::spawn(async move {
                    // Dropping the JoinSet (when the accept loop is aborted)
                    // aborts every parked Stall connection with it.
                    let mut tasks = JoinSet::new();
                    loop {
                        let Ok((stream, _)) = listener.accept().await else {
                            break;
                        };
                        counting.fetch_add(1, Ordering::SeqCst);
                        tasks.spawn(async move {
                            if matches!(fault, Fault::Stall) {
                                // Hold the socket open and say nothing.
                                let _held = stream;
                                std::future::pending::<()>().await;
                            }
                            // Reset: drop on the spot — an abrupt close.
                        });
                    }
                });
                Self {
                    url: format!("http://{addr}"),
                    connections,
                    accept_loop,
                }
            }

            pub(crate) fn url(&self) -> &str {
                &self.url
            }

            /// Connections accepted so far — the fail-closed witness.
            pub(crate) fn connections(&self) -> usize {
                self.connections.load(Ordering::SeqCst)
            }
        }

        impl Drop for FaultListener {
            fn drop(&mut self) {
                self.accept_loop.abort();
            }
        }
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

        // Contract with apps/pages: `probeDaemon` parses exactly these keys,
        // and pairing writes settings from what it finds. Widening /health
        // here without widening that parser is how the browser ended up
        // asserting upstream ports the daemon never stated — see
        // apps/pages/src/lib/__tests__/daemon-health.contract.test.ts.
        let obj = json.as_object().expect("health is an object");
        let mut keys: Vec<&str> = obj.keys().map(String::as_str).collect();
        keys.sort_unstable();
        assert_eq!(keys, ["service", "status", "tailscale_url"]);
        assert_eq!(json["service"], "opensesame-daemon");
        // Upstream planes stay on the operator-token-gated toolbar status.
        assert!(obj.get("host_api").is_none());
        assert!(obj.get("identity_api").is_none());
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

    /// A request carrying the UDS connect info axum inserts per connection.
    #[cfg(unix)]
    fn uds_peer_request(
        uid: Option<u32>,
        uri: &str,
        with_token: bool,
    ) -> axum::http::Request<axum::body::Body> {
        use axum::body::Body;
        use axum::http::Request;
        let mut builder = Request::builder().method("POST").uri(uri);
        if with_token {
            builder = builder.header("x-opensesame-operator", DEV_OPERATOR_TOKEN);
        }
        let mut req = builder.body(Body::empty()).unwrap();
        let cred = uid.map(|uid| opensesame_uds_authn::PeerCred {
            pid: 4242,
            uid,
            gid: uid,
        });
        req.extensions_mut()
            .insert(ConnectInfo(UdsConnectInfo(cred)));
        req
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn uds_same_uid_authorizes_without_a_token() {
        use tower::ServiceExt;

        let (app, st) = test_app("http://127.0.0.1:8787");
        let own = st.allowed_uids[0];
        let res = app
            .oneshot(uds_peer_request(Some(own), "/v1/list_sessions", false))
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn uds_foreign_uid_denied_even_with_a_valid_token() {
        use tower::ServiceExt;

        // The bearer token is the TCP path; on the socket the kernel-attested
        // uid governs, so a stolen token must not rescue a foreign process.
        let (app, st) = test_app("http://127.0.0.1:8787");
        let foreign = st.allowed_uids[0] + 1;
        let res = app
            .oneshot(uds_peer_request(Some(foreign), "/v1/list_sessions", true))
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn uds_unattested_peer_fails_closed() {
        use tower::ServiceExt;

        let (app, _) = test_app("http://127.0.0.1:8787");
        let res = app
            .oneshot(uds_peer_request(None, "/v1/list_sessions", true))
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::SERVICE_UNAVAILABLE);
    }

    #[tokio::test]
    async fn tcp_operator_token_path_is_unchanged() {
        use axum::body::Body;
        use axum::http::Request;
        use tower::ServiceExt;

        // No connect info extension — this is what a TCP request looks like.
        let (app, _) = test_app("http://127.0.0.1:8787");
        let req = Request::builder()
            .method("POST")
            .uri("/v1/list_sessions")
            .header("x-opensesame-operator", DEV_OPERATOR_TOKEN)
            .body(Body::empty())
            .unwrap();
        let res = app.oneshot(req).await.unwrap();
        assert_eq!(res.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn discover_is_rate_limited_per_caller() {
        use axum::body::{to_bytes, Body};
        use axum::http::Request;
        use tower::ServiceExt;

        let (app, _) = test_app("http://127.0.0.1:8787");
        let discover = || {
            Request::builder()
                .method("POST")
                .uri("/v1/discover")
                .header("x-opensesame-operator", DEV_OPERATOR_TOKEN)
                .body(Body::empty())
                .unwrap()
        };
        let first = app.clone().oneshot(discover()).await.unwrap();
        assert_eq!(first.status(), StatusCode::OK);
        let second = app.oneshot(discover()).await.unwrap();
        assert_eq!(second.status(), StatusCode::TOO_MANY_REQUESTS);
        let retry: u64 = second
            .headers()
            .get(header::RETRY_AFTER)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.parse().ok())
            .expect("Retry-After header");
        assert!((1..=5).contains(&retry), "retry_after {retry}");
        let body = to_bytes(second.into_body(), 1024).await.unwrap();
        let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(json["error"], "rate_limited");
    }

    /// Minimal promote body: confirm is false, so an authenticated caller
    /// stops at 400 without probing — these tests exercise the fences, not
    /// the handshake (that lives in promote.rs against a stub gateway).
    fn promote_request() -> axum::http::Request<axum::body::Body> {
        use axum::body::Body;
        use axum::http::Request;
        Request::builder()
            .method("POST")
            .uri("/v1/promote")
            .header("content-type", "application/json")
            .header("x-opensesame-operator", DEV_OPERATOR_TOKEN)
            .body(Body::from(
                r#"{"provider_id":"github","source":{"kind":"env_var","name":"GITHUB_TOKEN"},"mode":"import","confirm":false}"#,
            ))
            .unwrap()
    }

    #[tokio::test]
    async fn adversarial_promotion_is_refused_without_the_operator_token() {
        use axum::body::Body;
        use axum::http::Request;
        use tower::ServiceExt;

        // Mutating *and* value-reading: the token fence is the whole game on TCP.
        let (app, _) = test_app("http://127.0.0.1:8787");
        let req = Request::builder()
            .method("POST")
            .uri("/v1/promote")
            .header("content-type", "application/json")
            .body(Body::from(
                r#"{"provider_id":"github","source":{"kind":"env_var","name":"GITHUB_TOKEN"},"mode":"import","confirm":true}"#,
            ))
            .unwrap();
        let res = app.oneshot(req).await.unwrap();
        assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn promote_is_rate_limited_on_its_own_bucket() {
        use axum::body::to_bytes;
        use tower::ServiceExt;

        let (app, _) = test_app("http://127.0.0.1:8787");
        let first = app.clone().oneshot(promote_request()).await.unwrap();
        // Auth and budget pass; the unconfirmed request is refused.
        assert_eq!(first.status(), StatusCode::BAD_REQUEST);
        let second = app.oneshot(promote_request()).await.unwrap();
        assert_eq!(second.status(), StatusCode::TOO_MANY_REQUESTS);
        let body = to_bytes(second.into_body(), 1024).await.unwrap();
        let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(json["error"], "rate_limited");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn promote_honors_uds_peer_attestation() {
        use axum::body::Body;
        use axum::http::Request;
        use tower::ServiceExt;

        let body = r#"{"provider_id":"github","source":{"kind":"env_var","name":"GITHUB_TOKEN"},"mode":"import","confirm":false}"#;
        let build = |uid: Option<u32>| {
            let mut req = Request::builder()
                .method("POST")
                .uri("/v1/promote")
                .header("content-type", "application/json")
                .body(Body::from(body))
                .unwrap();
            let cred = uid.map(|uid| opensesame_uds_authn::PeerCred {
                pid: 4242,
                uid,
                gid: uid,
            });
            req.extensions_mut()
                .insert(ConnectInfo(UdsConnectInfo(cred)));
            req
        };
        let (app, st) = test_app("http://127.0.0.1:8787");
        let own = st.allowed_uids[0];
        // Attested same-uid caller passes auth and reaches the confirm gate.
        let res = app.clone().oneshot(build(Some(own))).await.unwrap();
        assert_eq!(res.status(), StatusCode::BAD_REQUEST);
        // A foreign uid is denied even though it would pass the confirm gate.
        let res = app.oneshot(build(Some(own + 1))).await.unwrap();
        assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn discover_response_is_size_capped_and_says_so() {
        use axum::body::to_bytes;
        use opensesame_connection_detect::{
            build_report, CapabilityClass, Confidence, OfferItem, ProbeSource,
        };

        let items = (0..20_000)
            .map(|i| OfferItem {
                provider_id: format!("provider-{i}"),
                source: ProbeSource::EnvVar {
                    name: format!("PLANTED_VAR_{i}"),
                },
                capabilities: vec![CapabilityClass::Importable],
                confidence: Confidence::Low,
                registry_hint: None,
            })
            .collect();
        let report = discovery::DiscoveryReport {
            report: build_report("test-host".into(), 0, items),
            note: "test",
        };
        let res = discover_response(report);
        assert_eq!(res.status(), StatusCode::OK);
        let body = to_bytes(res.into_body(), MAX_DISCOVER_RESPONSE_BYTES + 1024)
            .await
            .unwrap();
        assert!(body.len() <= MAX_DISCOVER_RESPONSE_BYTES, "{}", body.len());
        let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(json["truncated"], true);
    }

    #[cfg(not(feature = "tailscale"))]
    #[test]
    fn tailnet_listener_is_compiled_out_by_default() {
        // The tailnet listener exists only under `--features tailscale`; this
        // pin documents that a default build carries no tailnet surface.
        assert!(!cfg!(feature = "tailscale"));
    }

    #[cfg(test)]
    mod characterization {
        use super::*;
        use axum::body::{to_bytes, Body};
        use axum::http::Request;
        use tower::ServiceExt;

        /// Snapshots of the daemon auth boundary's refusal bodies: the TCP
        /// operator-token denial and the UDS peer-cred denials.
        ///
        /// These do not assert the shapes are *right* — the tests above do
        /// that. They pin what the boundary actually serializes, so a new
        /// field has to be looked at and accepted rather than shipped
        /// unnoticed. A refusal body is an oracle for whoever is probing the
        /// fence: it should name the failure class and the remediation,
        /// nothing about the caller, the token, or the machine. If one of
        /// these fails, read the diff — a new key here is a disclosure
        /// decision.
        #[tokio::test]
        async fn operator_unauthorized_wire_shape_is_pinned() {
            let (app, _) = test_app("http://127.0.0.1:1");
            let req = Request::builder()
                .method("POST")
                .uri("/v1/discover")
                .body(Body::empty())
                .unwrap();
            let res = app.oneshot(req).await.unwrap();
            assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
            let bytes = to_bytes(res.into_body(), 4096).await.unwrap();
            let body: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
            insta::assert_json_snapshot!(body);
        }

        #[cfg(unix)]
        #[tokio::test]
        async fn uds_peer_unauthorized_wire_shape_is_pinned() {
            let (app, st) = test_app("http://127.0.0.1:1");
            let foreign = st.allowed_uids[0] + 1;
            let res = app
                .oneshot(uds_peer_request(Some(foreign), "/v1/list_sessions", false))
                .await
                .unwrap();
            assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
            let bytes = to_bytes(res.into_body(), 4096).await.unwrap();
            let body: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
            // The detail names the peer's uid — machine-specific, so redact
            // it; the class and hint are the stable contract.
            insta::assert_json_snapshot!(body, {
                ".detail" => "[uid detail]",
            });
        }

        #[cfg(unix)]
        #[tokio::test]
        async fn uds_peer_unattested_wire_shape_is_pinned() {
            let (app, _) = test_app("http://127.0.0.1:1");
            let res = app
                .oneshot(uds_peer_request(None, "/v1/list_sessions", false))
                .await
                .unwrap();
            assert_eq!(res.status(), StatusCode::SERVICE_UNAVAILABLE);
            let bytes = to_bytes(res.into_body(), 4096).await.unwrap();
            let body: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
            insta::assert_json_snapshot!(body);
        }
    }
}
