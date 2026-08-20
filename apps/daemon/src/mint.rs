//! Daemon mint passthrough (ADR 0049 §4): `POST /v1/mint`.
//!
//! The helper binaries (`git-credential-opensesame` and friends) are thin UDS
//! clients with no credential handling of their own; this route is what they
//! call. It forwards to the gateway's `POST /api/v1/connections/{id}/mint`
//! via `operator_forward` — the operator token never leaves the loopback
//! fence (`remote_host_api` denies a non-local `OPENSESAME_SERVER`) — and
//! passes the gateway's status and body through untouched.
//!
//! Auth is `require_operator` exactly like `/v1/discover`: over the UDS the
//! kernel-attested peer UID is the credential (the helpers run as the same
//! user, so they need no token), over TCP the operator bearer remains.
//!
//! The mint response carries `derived_token` bytes — permitted only because
//! it is a provider-minted, short-lived, revocable derived token on a
//! connection whose owner opted into `materialization = derived_short_lived`
//! (ADR 0049 §1/§2/§6). The daemon does not inspect, cache, or log it; the
//! body crosses this route as opaque JSON.

use axum::{
    extract::{ConnectInfo, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Extension, Json,
};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::{operator_forward, rate_limited, require_operator, App, RateKey, UdsPeer};

/// The request is two short strings; anything larger is junk.
pub const MAX_BODY_BYTES: usize = 4 * 1024;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MintRequest {
    pub connection_id: String,
    /// GitHub App installation id; required for github connections, passed
    /// through uninterpreted.
    #[serde(default)]
    pub installation_id: Option<String>,
}

/// `POST /v1/mint` — forward to the gateway mint route, pass the answer back.
pub async fn mint_via_daemon(
    State(st): State<App>,
    uds: UdsPeer,
    headers: HeaderMap,
    Json(req): Json<MintRequest>,
) -> Response {
    if let Err(resp) = require_operator(&st, &headers, &uds) {
        return resp;
    }
    let key = match uds.and_then(|Extension(ConnectInfo(info))| info.0) {
        Some(cred) => RateKey::Uid(cred.uid),
        None => RateKey::TcpOperator,
    };
    if let Err(retry_after) = st.mint_limiter.check(key) {
        return rate_limited(retry_after);
    }
    if !opensesame_host_core::http_security::is_safe_path_id(&req.connection_id) {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error": "invalid_connection_id"})),
        )
            .into_response();
    }
    let url = format!(
        "{}/api/v1/connections/{}/mint",
        st.host_api, req.connection_id
    );
    let forward = match operator_forward(&st, &url) {
        Ok(forward) => forward,
        Err(resp) => return resp,
    };
    let mut body = json!({});
    if let Some(installation_id) = &req.installation_id {
        body["installation_id"] = json!(installation_id);
    }
    match forward.json(&body).send().await {
        Ok(upstream) => {
            let status =
                StatusCode::from_u16(upstream.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
            let body = upstream
                .json::<Value>()
                .await
                .unwrap_or_else(|_| json!({"error": "gateway_unparseable"}));
            // 422 unmintable, 403 policy-denied, 200 with a derived token:
            // all are the gateway's answer, passed through as-is.
            (status, Json(body)).into_response()
        }
        Err(_) => (
            StatusCode::BAD_GATEWAY,
            Json(json!({
                "error": "host_api_unreachable",
                "hint": "is Host API up on OPENSESAME_SERVER?"
            })),
        )
            .into_response(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{router, tests::test_state};
    use axum::body::{to_bytes, Body};
    use axum::http::Request;
    use axum::routing::post;
    use axum::Router;
    use std::sync::{Arc, Mutex};
    use tower::ServiceExt;

    const OPERATOR: &str = "opensesame-dev-operator";

    fn request(body: &str, with_token: bool) -> Request<Body> {
        let mut builder = Request::builder()
            .method("POST")
            .uri("/v1/mint")
            .header("content-type", "application/json");
        if with_token {
            builder = builder.header("x-opensesame-operator", OPERATOR);
        }
        builder.body(Body::from(body.to_string())).unwrap()
    }

    /// A stub gateway mint endpoint recording the forwarded body.
    async fn spawn_gateway(status: StatusCode, body: Value) -> (String, Arc<Mutex<Vec<Value>>>) {
        #[derive(Clone)]
        struct Stub {
            calls: Arc<Mutex<Vec<Value>>>,
            status: StatusCode,
            body: Value,
        }
        let calls = Arc::new(Mutex::new(Vec::new()));
        let stub = Stub {
            calls: calls.clone(),
            status,
            body,
        };
        let app = Router::new()
            .route(
                "/api/v1/connections/{id}/mint",
                post(
                    |State(stub): State<Stub>, Json(body): Json<Value>| async move {
                        stub.calls.lock().unwrap().push(body);
                        (stub.status, Json(stub.body.clone()))
                    },
                ),
            )
            .with_state(stub);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        (format!("http://127.0.0.1:{}", addr.port()), calls)
    }

    #[tokio::test]
    async fn unauthenticated_callers_are_refused() {
        let app = router(test_state("http://127.0.0.1:1"));
        let res = app
            .oneshot(request(r#"{"connection_id":"conn_stub"}"#, false))
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn unsafe_connection_ids_never_reach_the_gateway() {
        for id in ["../admin", "a b", "x/../y", "short"] {
            // Fresh state per id: the rate bucket is per-caller, not per-id.
            let app = router(test_state("http://127.0.0.1:1"));
            let body = format!(r#"{{"connection_id":"{id}"}}"#);
            let res = app.oneshot(request(&body, true)).await.unwrap();
            assert_eq!(res.status(), StatusCode::BAD_REQUEST, "{id}");
            let bytes = to_bytes(res.into_body(), 4096).await.unwrap();
            let json: Value = serde_json::from_slice(&bytes).unwrap();
            assert_eq!(json["error"], "invalid_connection_id");
        }
    }

    #[tokio::test]
    async fn mint_is_rate_limited_on_its_own_bucket() {
        let app = router(test_state("http://127.0.0.1:1"));
        let first = app
            .clone()
            .oneshot(request(r#"{"connection_id":"conn_stub"}"#, true))
            .await
            .unwrap();
        // Auth and budget pass; the unreachable gateway answers 502.
        assert_eq!(first.status(), StatusCode::BAD_GATEWAY);
        let second = app
            .oneshot(request(r#"{"connection_id":"conn_stub"}"#, true))
            .await
            .unwrap();
        assert_eq!(second.status(), StatusCode::TOO_MANY_REQUESTS);
    }

    #[tokio::test]
    async fn a_successful_mint_passes_the_gateway_answer_through() {
        let derived = json!({
            "connection_id": "conn_stub",
            "provider_id": "github",
            "kind": "github_app_installation",
            "derived_token": "ghs_derived-token",
            "expires_at": "2026-08-20T03:00:00Z",
            "subject": "user:alice",
            "actor": "operator",
            "issued_at": "2026-08-20T02:00:00Z",
        });
        let (gateway, calls) = spawn_gateway(StatusCode::OK, derived).await;
        let app = router(test_state(&gateway));
        let res = app
            .oneshot(request(
                r#"{"connection_id":"conn_stub","installation_id":"12345678"}"#,
                true,
            ))
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        let bytes = to_bytes(res.into_body(), 8192).await.unwrap();
        let json: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(json["derived_token"], "ghs_derived-token");
        assert_eq!(json["kind"], "github_app_installation");
        let calls = calls.lock().unwrap();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0]["installation_id"], "12345678");
    }

    #[tokio::test]
    async fn unmintable_is_a_passthrough_not_a_rewrite() {
        let (gateway, _) = spawn_gateway(
            StatusCode::UNPROCESSABLE_ENTITY,
            json!({"error": "unmintable"}),
        )
        .await;
        let app = router(test_state(&gateway));
        let res = app
            .oneshot(request(r#"{"connection_id":"conn_stub"}"#, true))
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::UNPROCESSABLE_ENTITY);
        let bytes = to_bytes(res.into_body(), 4096).await.unwrap();
        let json: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(json["error"], "unmintable");
    }

    #[tokio::test]
    async fn a_partitioned_gateway_is_502() {
        let app = router(test_state("http://127.0.0.1:1"));
        let res = app
            .oneshot(request(r#"{"connection_id":"conn_stub"}"#, true))
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::BAD_GATEWAY);
        let bytes = to_bytes(res.into_body(), 4096).await.unwrap();
        let json: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(json["error"], "host_api_unreachable");
    }
}
