//! Narrow public callback edge — OAuth/webhook/ACME only.
use axum::{
    body::Bytes,
    extract::Path,
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use clap::Parser;
use hmac::{Hmac, Mac};
use serde_json::{json, Value};
use sha2::Sha256;
use std::net::SocketAddr;

type HmacSha256 = Hmac<Sha256>;

#[derive(Parser)]
struct Args {
    #[arg(long, default_value = "127.0.0.1:8791")]
    listen: SocketAddr,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt().init();
    let args = Args::parse();
    let app = opensesame_host_core::http_security::apply_security_headers(
        Router::new()
            .route(
                "/health/live",
                get(|| async { Json(json!({"status": "ok"})) }),
            )
            .route("/oauth/callback/{profile}", post(oauth_callback))
            .route("/webhooks/{connection_public_id}/{route}", post(webhook)),
        false,
    );
    let listen = args.listen.to_string();
    opensesame_host_core::daemon::assert_tcp_listen_allowed(&listen).map_err(anyhow::Error::msg)?;
    tracing::info!(%listen, "callback-edge listening (no vault read API)");
    let listener = tokio::net::TcpListener::bind(args.listen).await?;
    axum::serve(listener, app).await?;
    Ok(())
}

async fn oauth_callback(Path(profile): Path<String>, Json(body): Json<Value>) -> Json<Value> {
    // Store codes only ephemerally in real deploy; here acknowledge without persisting secrets.
    let _ = body.get("code");
    Json(json!({"accepted": true, "profile": profile, "forward": "signed-one-time-event"}))
}

fn verify_hub_signature(secret: &str, body: &[u8], signature_header: &str) -> bool {
    let Some(hex) = signature_header
        .strip_prefix("sha256=")
        .or_else(|| signature_header.strip_prefix("SHA256="))
    else {
        return false;
    };
    let Ok(mut mac) = HmacSha256::new_from_slice(secret.as_bytes()) else {
        return false;
    };
    mac.update(body);
    let Ok(provided) = hex::decode(hex) else {
        return false;
    };
    mac.verify_slice(&provided).is_ok()
}

fn is_safe_edge_segment(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && !value.contains(['/', '?', '#', '\\'])
        && !value.contains("..")
}

async fn webhook(
    Path((connection_public_id, route)): Path<(String, String)>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    if !is_safe_edge_segment(&connection_public_id) || !is_safe_edge_segment(&route) {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error": "invalid_path"})),
        )
            .into_response();
    }
    let secret = std::env::var("OPENSESAME_CALLBACK_WEBHOOK_SECRET").unwrap_or_default();
    if secret.is_empty() {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({"error": "webhook_unconfigured"})),
        )
            .into_response();
    }
    let signature = headers
        .get("x-hub-signature-256")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    if !verify_hub_signature(&secret, &body, signature) {
        return (
            StatusCode::UNAUTHORIZED,
            Json(json!({"error": "invalid_signature"})),
        )
            .into_response();
    }
    Json(json!({
        "accepted": true,
        "connection_public_id": connection_public_id,
        "route": route
    }))
    .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;
    use hmac::Mac;

    fn sign(secret: &str, body: &[u8]) -> String {
        let mut mac = HmacSha256::new_from_slice(secret.as_bytes()).unwrap();
        mac.update(body);
        format!("sha256={}", hex::encode(mac.finalize().into_bytes()))
    }

    #[test]
    fn hmac_rejects_missing_and_wrong_signatures() {
        let body = b"{\"ok\":true}";
        assert!(!verify_hub_signature("whsec", body, ""));
        assert!(!verify_hub_signature("whsec", body, "sha256=00"));
        assert!(verify_hub_signature("whsec", body, &sign("whsec", body)));
        assert!(!verify_hub_signature("whsec", body, &sign("other", body)));
    }

    #[test]
    fn path_segments_reject_traversal() {
        assert!(is_safe_edge_segment("conn_abc"));
        assert!(!is_safe_edge_segment("../admin"));
        assert!(!is_safe_edge_segment("a/b"));
        assert!(!is_safe_edge_segment("x?y=1"));
    }

    #[test]
    fn production_verifies_hmac_before_accepting() {
        opensesame_host_core::pact::assert_source_order(
            include_str!("main.rs"),
            &[
                "is_safe_edge_segment(&connection_public_id)",
                "OPENSESAME_CALLBACK_WEBHOOK_SECRET",
                "verify_hub_signature(&secret",
                "invalid_signature",
            ],
        );
    }

    // The process-global environment must stay locked until the handler has read it.
    #[allow(clippy::await_holding_lock)]
    #[tokio::test]
    async fn missing_secret_is_unconfigured_not_open() {
        let _guard = env_lock();
        std::env::remove_var("OPENSESAME_CALLBACK_WEBHOOK_SECRET");
        let response = webhook(
            Path(("conn_1".into(), "github".into())),
            HeaderMap::new(),
            Bytes::from_static(b"{}"),
        )
        .await;
        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    }

    // The process-global environment must stay locked until the handler has read it.
    #[allow(clippy::await_holding_lock)]
    #[tokio::test]
    async fn valid_hmac_is_accepted() {
        let _guard = env_lock();
        std::env::set_var("OPENSESAME_CALLBACK_WEBHOOK_SECRET", "whsec_test");
        let body = Bytes::from_static(b"{\"action\":\"ping\"}");
        let mut headers = HeaderMap::new();
        headers.insert(
            "x-hub-signature-256",
            sign("whsec_test", &body).parse().unwrap(),
        );
        let response = webhook(
            Path(("conn_1".into(), "github".into())),
            headers,
            body,
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
    }

    fn env_lock() -> std::sync::MutexGuard<'static, ()> {
        static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
        LOCK.lock().unwrap_or_else(|p| p.into_inner())
    }
}
