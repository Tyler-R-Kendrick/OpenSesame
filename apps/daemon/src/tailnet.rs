//! Feature-gated tailnet listener (ADR 0048 §8, D9) — `--features tailscale`,
//! default OFF.
//!
//! When enabled, the daemon additionally binds its tailnet IPv4 and serves
//! exactly two read-only routes there: `GET /health` and `POST /v1/discover`.
//! Nothing mutating is exposed, and no bearer token is accepted — every
//! request's remote address is resolved to a tailnet identity through the
//! tailscaled LocalAPI `whois` (identity from the platform, not a presented
//! secret) and authorized against explicit user/tag allowlists. Every failure
//! mode is closed: tailscaled unreachable at startup → the listener is never
//! bound; whois fails or the identity matches nothing → 403; both allowlists
//! empty → the listener serves nobody.

use crate::ratelimit::RateKey;
use crate::App;
use axum::extract::connect_info::ConnectInfo;
use axum::extract::{Request, State};
use axum::http::StatusCode;
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Extension, Json, Router};
use serde_json::json;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::time::Duration;

pub const ENV_ALLOW_USERS: &str = "OPENSESAME_TAILSCALE_ALLOW_USERS";
pub const ENV_ALLOW_TAGS: &str = "OPENSESAME_TAILSCALE_ALLOW_TAGS";
pub const ENV_SOCKET: &str = "OPENSESAME_TAILSCALE_SOCKET";

#[derive(Clone, Debug)]
pub struct TailnetPolicy {
    pub allowed_users: Vec<String>,
    pub allowed_tags: Vec<String>,
    pub whois_socket: PathBuf,
}

impl TailnetPolicy {
    pub fn from_env() -> Self {
        let read = |key: &str| std::env::var(key).unwrap_or_default();
        let socket = std::env::var(ENV_SOCKET)
            .ok()
            .filter(|s| !s.is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(opensesame_tailscale_authn::DEFAULT_SOCKET_PATH));
        Self {
            allowed_users: opensesame_tailscale_authn::parse_csv(&read(ENV_ALLOW_USERS)),
            allowed_tags: opensesame_tailscale_authn::parse_csv(&read(ENV_ALLOW_TAGS)),
            whois_socket: socket,
        }
    }

    /// With both allowlists empty the listener would deny every caller; that
    /// is a misconfiguration worth a startup warning, not a silent bind.
    pub fn allows_anyone(&self) -> bool {
        !self.allowed_users.is_empty() || !self.allowed_tags.is_empty()
    }
}

/// Tailnet identity attached to a request that passed the whois gate; doubles
/// as the rate-limit key.
#[derive(Clone, Debug)]
pub struct TailnetPeer(pub String);

/// Resolve this node's tailnet IPv4 and confirm tailscaled answers before
/// exposing anything behind it. `None` = do not bind (fail closed).
pub async fn bind_listener(
    listen: &str,
    policy: &TailnetPolicy,
) -> Option<tokio::net::TcpListener> {
    let port = crate::tailscale::listen_port(listen)?;
    let socket = policy.whois_socket.clone();
    let tailscaled_up = tokio::task::spawn_blocking(move || {
        std::os::unix::net::UnixStream::connect(socket).is_ok()
    })
    .await
    .unwrap_or(false);
    if !tailscaled_up {
        tracing::warn!(
            socket = %policy.whois_socket.display(),
            "tailscaled socket unreachable; tailnet listener not bound (fail closed)"
        );
        return None;
    }
    let ip = tokio::task::spawn_blocking(crate::tailscale::self_tailnet_ipv4)
        .await
        .ok()
        .flatten()?;
    let addr = format!("{ip}:{port}");
    match tokio::net::TcpListener::bind(&addr).await {
        Ok(listener) => Some(listener),
        Err(error) => {
            tracing::warn!(%addr, %error, "failed to bind tailnet listener");
            None
        }
    }
}

/// The gate: resolve the remote address through tailscaled whois and require
/// an allowlisted user or tag. Failures deny — a listener whose identity
/// oracle is down serves nobody.
async fn whois_gate(
    State(policy): State<TailnetPolicy>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    mut req: Request,
    next: Next,
) -> Response {
    let addr_text = addr.to_string();
    let socket = policy.whois_socket.clone();
    let looked_up = tokio::task::spawn_blocking(move || {
        opensesame_tailscale_authn::whois_via(&socket, &addr_text, Duration::from_secs(2))
    })
    .await;
    let identity = match looked_up {
        Ok(Ok(identity)) => identity,
        Ok(Err(error)) => {
            tracing::warn!(%error, "tailnet whois failed; denying");
            return (
                StatusCode::FORBIDDEN,
                Json(json!({"error": "tailnet_whois_failed"})),
            )
                .into_response();
        }
        Err(error) => {
            tracing::warn!(%error, "tailnet whois task failed; denying");
            return (
                StatusCode::FORBIDDEN,
                Json(json!({"error": "tailnet_whois_failed"})),
            )
                .into_response();
        }
    };
    if !opensesame_tailscale_authn::authorize(
        &identity,
        &policy.allowed_users,
        &policy.allowed_tags,
    ) {
        return (
            StatusCode::FORBIDDEN,
            Json(json!({"error": "tailnet_identity_not_allowed"})),
        )
            .into_response();
    }
    let key = identity.key().unwrap_or_else(|| addr.to_string());
    req.extensions_mut().insert(TailnetPeer(key));
    next.run(req).await
}

/// Discovery over the tailnet. The whois gate already authorized this caller;
/// no operator token is consulted or accepted on this listener.
async fn tailnet_discover(
    State(st): State<App>,
    Extension(peer): Extension<TailnetPeer>,
) -> Response {
    if let Err(retry_after) = st.discover_limiter.check(RateKey::Tailnet(peer.0)) {
        return crate::rate_limited(retry_after);
    }
    match tokio::task::spawn_blocking(crate::discovery::report).await {
        Ok(report) => crate::discover_response(report),
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}

/// The tailnet surface: liveness and discovery only, behind the whois gate.
pub fn router(state: App, policy: TailnetPolicy) -> Router {
    Router::new()
        .route("/health", get(crate::daemon_health))
        .route("/v1/discover", post(tailnet_discover))
        .route_layer(middleware::from_fn_with_state(policy, whois_gate))
        .with_state(state)
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::{to_bytes, Body};
    use std::io::{Read, Write};
    use std::os::unix::net::UnixListener;
    use tower::ServiceExt;

    fn policy(socket: PathBuf, users: &[&str], tags: &[&str]) -> TailnetPolicy {
        TailnetPolicy {
            allowed_users: users.iter().map(|s| s.to_string()).collect(),
            allowed_tags: tags.iter().map(|s| s.to_string()).collect(),
            whois_socket: socket,
        }
    }

    /// A one-shot tailscaled stub speaking just enough HTTP for whois.
    fn stub_tailscaled(response: &'static str) -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "daemon-tailnet-test-{}-{:?}.sock",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_file(&path);
        let listener = UnixListener::bind(&path).expect("bind stub");
        std::thread::spawn(move || {
            if let Ok((mut stream, _)) = listener.accept() {
                let mut buf = [0u8; 4096];
                let _ = stream.read(&mut buf);
                let _ = stream.write_all(response.as_bytes());
            }
        });
        path
    }

    fn gated_health_request() -> Request {
        let mut req = Request::builder()
            .uri("/health")
            .body(Body::empty())
            .unwrap();
        // The extension axum inserts per connection on this listener.
        req.extensions_mut()
            .insert(ConnectInfo(SocketAddr::from(([100, 64, 0, 7], 51522))));
        req
    }

    const WHOIS_ALICE: &str = "HTTP/1.1 200 OK\r\nContent-Length: 83\r\n\r\n{\"UserProfile\":{\"LoginName\":\"alice@example.com\"},\"Node\":{\"Name\":\"a.ts.net.\"}}";

    #[tokio::test]
    async fn allowlisted_user_passes_the_gate() {
        let socket = stub_tailscaled(WHOIS_ALICE);
        let app = router(
            test_state(),
            policy(socket.clone(), &["alice@example.com"], &[]),
        );
        let res = app.oneshot(gated_health_request()).await.unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        let _ = std::fs::remove_file(&socket);
    }

    #[tokio::test]
    async fn unlisted_identity_is_denied() {
        let socket = stub_tailscaled(WHOIS_ALICE);
        let app = router(
            test_state(),
            policy(socket.clone(), &["carol@example.com"], &[]),
        );
        let res = app.oneshot(gated_health_request()).await.unwrap();
        assert_eq!(res.status(), StatusCode::FORBIDDEN);
        let body = to_bytes(res.into_body(), 1024).await.unwrap();
        let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(json["error"], "tailnet_identity_not_allowed");
        let _ = std::fs::remove_file(&socket);
    }

    #[tokio::test]
    async fn whois_failure_denies_even_an_allowlisted_user() {
        let missing = std::env::temp_dir().join("daemon-tailnet-test-absent.sock");
        let _ = std::fs::remove_file(&missing);
        let app = router(test_state(), policy(missing, &["alice@example.com"], &[]));
        let res = app.oneshot(gated_health_request()).await.unwrap();
        assert_eq!(res.status(), StatusCode::FORBIDDEN);
        let body = to_bytes(res.into_body(), 1024).await.unwrap();
        let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(json["error"], "tailnet_whois_failed");
    }

    #[tokio::test]
    async fn bind_refused_when_tailscaled_is_absent() {
        let missing = std::env::temp_dir().join("daemon-tailnet-test-absent-bind.sock");
        let _ = std::fs::remove_file(&missing);
        let policy = policy(missing, &["alice@example.com"], &[]);
        assert!(bind_listener("127.0.0.1:18790", &policy).await.is_none());
    }

    #[test]
    fn empty_allowlists_disable_the_listener() {
        assert!(!policy(PathBuf::from("/x"), &[], &[]).allows_anyone());
        assert!(policy(PathBuf::from("/x"), &[], &["tag:ops"]).allows_anyone());
        assert!(policy(PathBuf::from("/x"), &["alice@example.com"], &[]).allows_anyone());
    }

    fn test_state() -> App {
        crate::tests::test_state("http://127.0.0.1:1")
    }
}
