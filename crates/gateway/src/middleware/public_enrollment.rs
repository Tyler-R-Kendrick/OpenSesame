//! Public enrollment budgets use transport evidence, never forwarded headers.
use std::{
    collections::HashMap,
    net::SocketAddr,
    time::{Duration, Instant},
};

use axum::{
    extract::{ConnectInfo, Request, State},
    http::{Method, StatusCode},
    middleware::Next,
    response::{IntoResponse, Response},
    Json,
};
use opensesame_ingress_evidence::OriginatingPeerExtension;
use opensesame_transport_security::PeerExtension;
use serde_json::json;

use crate::app_state::AppState;

const WINDOW: Duration = Duration::from_secs(15 * 60);
const PER_SOURCE: u32 = 8;
const MAX_SOURCES: usize = 4096;

#[derive(Default)]
pub(crate) struct Budgets(HashMap<(String, &'static str), (Instant, u32)>);

impl Budgets {
    fn admit(&mut self, source: String, route: &'static str, now: Instant) -> bool {
        self.0
            .retain(|_, (start, _)| now.duration_since(*start) < WINDOW);
        let key = (source, route);
        // Never evict a live budget: rotating sources must not reset old ones.
        if !self.0.contains_key(&key) && self.0.len() >= MAX_SOURCES {
            return false;
        }
        let (_, used) = self.0.entry(key).or_insert((now, 0));
        if *used >= PER_SOURCE {
            return false;
        }
        *used += 1;
        true
    }
}

pub(crate) async fn guard(State(st): State<AppState>, request: Request, next: Next) -> Response {
    let route = match (request.method(), request.uri().path()) {
        (&Method::POST, "/api/v1/agent-identities") => "claim",
        (&Method::POST, "/api/v1/device/authorize") => "device",
        _ => return next.run(request).await,
    };
    let source = if let Some(OriginatingPeerExtension(peer)) =
        request.extensions().get::<OriginatingPeerExtension>()
    {
        // Installed only after the trusted-ingress certificate assertion
        // has been verified. Do not charge all clients to the proxy IP.
        format!("originating-tls:{}", peer.leaf_thumbprint_sha256())
    } else if let Some(ConnectInfo(peer)) = request.extensions().get::<ConnectInfo<SocketAddr>>() {
        format!("ip:{}", peer.ip())
    } else if let Some(PeerExtension(peer)) = request.extensions().get::<PeerExtension>() {
        format!("tls:{}", peer.leaf_thumbprint_sha256())
    } else {
        // Embedders and unauthenticated TLS listeners without peer addresses
        // share a conservative budget; client headers cannot choose a key.
        "unknown".to_string()
    };
    let admitted = st
        .public_enrollment
        .lock()
        .unwrap()
        .admit(source, route, Instant::now());
    if !admitted {
        return (
            StatusCode::TOO_MANY_REQUESTS,
            Json(json!({"error":"enrollment_rate_limited"})),
        )
            .into_response();
    }
    next.run(request).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn budgets_do_not_evict_live_sources_and_expire_after_the_claim_lifetime() {
        let mut budgets = Budgets::default();
        let now = Instant::now();
        for _ in 0..PER_SOURCE {
            assert!(budgets.admit("one".into(), "claim", now));
        }
        assert!(!budgets.admit("one".into(), "claim", now));
        assert!(budgets.admit("two".into(), "claim", now));
        assert!(budgets.admit("one".into(), "device", now));
        for index in 0..MAX_SOURCES {
            budgets.admit(format!("source-{index}"), "claim", now);
        }
        assert!(!budgets.admit("new".into(), "claim", now));
        assert!(!budgets.admit("one".into(), "claim", now));
        assert!(budgets.admit("one".into(), "claim", now + WINDOW));
    }

    fn expected_status(limited: bool) -> StatusCode {
        if limited {
            StatusCode::TOO_MANY_REQUESTS
        } else {
            StatusCode::OK
        }
    }

    fn source_ip(index: u32) -> &'static str {
        if index <= PER_SOURCE {
            "192.0.2.1"
        } else {
            "192.0.2.2"
        }
    }

    #[tokio::test]
    async fn spoofed_headers_cannot_reset_a_source_budget() {
        use axum::{body::Body, http::Request};
        use tower::ServiceExt;
        let state = crate::app_state::test_demo_state().await;
        let app = crate::routes::router(state.clone());
        for index in 0..=PER_SOURCE {
            let request = Request::builder()
                .method("POST")
                .uri("/api/v1/agent-identities")
                .header("content-type", "application/json")
                .header("x-forwarded-for", format!("192.0.2.{index}"))
                .header("user-agent", format!("agent-{index}"))
                .body(Body::from(
                    r#"{"instance_public_key_jwk":{},"requested_grant_digest":"test"}"#,
                ))
                .unwrap();
            let response = app.clone().oneshot(request).await.unwrap();
            assert_eq!(response.status(), expected_status(index >= PER_SOURCE));
        }
        assert_eq!(
            state.claims.lock().unwrap().len(),
            usize::try_from(PER_SOURCE).unwrap()
        );
    }

    #[tokio::test]
    async fn socket_sources_are_independent_and_ports_do_not_reset_the_budget() {
        use axum::{body::Body, http::Request};
        use tower::ServiceExt;
        let state = crate::app_state::test_demo_state().await;
        let app = crate::routes::router(state.clone());
        for index in 0..=PER_SOURCE + 1 {
            let mut request = Request::builder()
                .method("POST")
                .uri("/api/v1/device/authorize")
                .header("content-type", "application/json")
                .body(Body::from(r#"{"client_id":"opensesame-cli"}"#))
                .unwrap();
            let ip = source_ip(index);
            let remote: SocketAddr = format!("{ip}:{}", 3000 + index).parse().unwrap();
            request.extensions_mut().insert(ConnectInfo(remote));
            let response = app.clone().oneshot(request).await.unwrap();
            assert_eq!(response.status(), expected_status(index == PER_SOURCE));
        }
        assert_eq!(
            state.device_codes.lock().unwrap().len(),
            usize::try_from(PER_SOURCE + 1).unwrap()
        );
    }

    #[tokio::test]
    async fn verified_originating_clients_have_independent_budgets_behind_one_proxy() {
        use crate::transport::test_support::{forwarded, peer, THUMB_A, THUMB_B};
        use axum::{body::Body, http::Request};
        use std::sync::Arc;
        use tower::ServiceExt;
        let state = crate::app_state::test_demo_state().await;
        let app = crate::routes::router(state);
        let ingress = peer("edge.test", THUMB_A, 1);
        for index in 0..=PER_SOURCE + 1 {
            let thumb = if index <= PER_SOURCE {
                THUMB_A
            } else {
                THUMB_B
            };
            let mut request = Request::builder()
                .method("POST")
                .uri("/api/v1/device/authorize")
                .header("content-type", "application/json")
                .header("client-cert", format!("untrusted-rotation-{index}"))
                .body(Body::from(r#"{"client_id":"opensesame-cli"}"#))
                .unwrap();
            request
                .extensions_mut()
                .insert(ConnectInfo("192.0.2.1:443".parse::<SocketAddr>().unwrap()));
            request
                .extensions_mut()
                .insert(PeerExtension(Arc::new(ingress.clone())));
            request
                .extensions_mut()
                .insert(OriginatingPeerExtension(Arc::new(forwarded(
                    "client.test",
                    thumb,
                    &ingress,
                ))));
            let response = app.clone().oneshot(request).await.unwrap();
            assert_eq!(response.status(), expected_status(index == PER_SOURCE));
        }
    }
}
