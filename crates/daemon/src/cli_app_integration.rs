//! CLI app-integration routes (`/v1/cli/app-integration/*`).
use axum::{
    extract::State,
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use opensesame_cli_app_integration::{session_id_from_pid, CliAppIntegrationStore};
use serde::Deserialize;
use serde_json::json;
use std::sync::{Arc, Mutex};

use axum::extract::connect_info::ConnectInfo;
use axum::Extension;

use crate::peer_auth::UdsConnectInfo;
use crate::{App, UdsPeer};

pub(crate) type SharedCliAppIntegration = Arc<Mutex<CliAppIntegrationStore>>;

pub(crate) fn fresh_store() -> SharedCliAppIntegration {
    Arc::new(Mutex::new(CliAppIntegrationStore::new()))
}

pub(crate) fn routes() -> Router<App> {
    Router::new()
        .route("/v1/cli/app-integration/ensure", post(ensure))
        .route("/v1/cli/app-integration/pending", get(pending))
        .route("/v1/cli/app-integration/respond", post(respond))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnsureReq {
    terminal_session_id: String,
    verb: String,
    reference: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RespondReq {
    request_id: String,
    terminal_session_id: String,
    decision: String,
}

fn terminal_session_for_ensure(uds: &UdsPeer, body: &EnsureReq) -> (String, bool) {
    #[cfg(unix)]
    if let Some(Extension(ConnectInfo(UdsConnectInfo(cred)))) = uds.as_ref() {
        if let Some(cred) = cred {
            if let Some(derived) = session_id_from_pid(cred.pid) {
                return (derived, true);
            }
        }
    }
    let trimmed = body.terminal_session_id.trim();
    let correlation = if trimmed.is_empty() {
        format!("tcp-ephemeral-{}", chrono::Utc::now().timestamp_nanos_opt().unwrap_or(0))
    } else {
        trimmed.to_string()
    };
    (correlation, false)
}

pub(crate) async fn ensure(
    State(st): State<App>,
    uds: UdsPeer,
    Json(req): Json<EnsureReq>,
) -> Response {
    let mut store = match st.cli_app_integration.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };
    store.set_now_ms(chrono::Utc::now().timestamp_millis() as u64);
    let (terminal_session_id, reuse) = terminal_session_for_ensure(&uds, &req);
    let (status, request_id) = store.ensure(
        &terminal_session_id,
        &req.verb,
        req.reference.as_deref(),
        reuse,
    );
    Json(json!({ "status": status, "requestId": request_id })).into_response()
}

pub(crate) async fn pending(State(st): State<App>) -> Response {
    let mut store = match st.cli_app_integration.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };
    store.set_now_ms(chrono::Utc::now().timestamp_millis() as u64);
    let rows = store
        .list_pending()
        .into_iter()
        .map(|row| {
            json!({
                "requestId": row.request_id,
                "terminalSessionId": row.terminal_session_id,
                "verb": row.verb,
                "reference": row.reference,
            })
        })
        .collect::<Vec<_>>();
    Json(json!({ "pending": rows })).into_response()
}

pub(crate) async fn respond(State(st): State<App>, Json(req): Json<RespondReq>) -> Response {
    let mut store = match st.cli_app_integration.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };
    store.set_now_ms(chrono::Utc::now().timestamp_millis() as u64);
    let status = match req.decision.as_str() {
        "approve" => store.approve(&req.request_id, &req.terminal_session_id),
        "deny" => store.deny(&req.request_id, &req.terminal_session_id),
        _ => {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({ "error": "invalid_decision" })),
            )
                .into_response();
        }
    };
    Json(json!({ "status": status })).into_response()
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::extract::connect_info::ConnectInfo;
    use axum::http::Request;
    use opensesame_uds_authn::PeerCred;
    use tower::ServiceExt;

    fn ensure_body(terminal_session_id: &str) -> String {
        serde_json::json!({
            "terminalSessionId": terminal_session_id,
            "verb": "read",
        })
        .to_string()
    }

    #[cfg(unix)]
    fn ensure_request(body: &str, cred: Option<PeerCred>) -> Request<Body> {
        let mut req = Request::builder()
            .method("POST")
            .uri("/v1/cli/app-integration/ensure")
            .header("content-type", "application/json")
            .body(Body::from(body.to_string()))
            .unwrap();
        req.extensions_mut()
            .insert(ConnectInfo(UdsConnectInfo(cred)));
        req
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn ensure_over_uds_ignores_body_terminal_session_id() {
        use crate::test_fixtures::test_router;

        let (app, _) = test_router("http://127.0.0.1:8787");
        let pid = std::process::id();
        let derived = session_id_from_pid(pid).expect("derived session");
        let cred = PeerCred {
            pid,
            uid: 0,
            gid: 0,
        };
        let body = ensure_body("forged-terminal-id");
        let res = app
            .clone()
            .oneshot(ensure_request(&body, Some(cred)))
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        let bytes = axum::body::to_bytes(res.into_body(), usize::MAX)
            .await
            .unwrap();
        let parsed: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(parsed["status"], "pending");
        let request_id = parsed["requestId"].as_str().expect("request id");
        let respond = Request::builder()
            .method("POST")
            .uri("/v1/cli/app-integration/respond")
            .header("content-type", "application/json")
            .body(Body::from(
                serde_json::json!({
                    "requestId": request_id,
                    "terminalSessionId": derived,
                    "decision": "approve",
                })
                .to_string(),
            ))
            .unwrap();
        let res = app.clone().oneshot(respond).await.unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        let res = app
            .clone()
            .oneshot(ensure_request(&body, Some(cred)))
            .await
            .unwrap();
        let bytes = axum::body::to_bytes(res.into_body(), usize::MAX)
            .await
            .unwrap();
        let parsed: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(parsed["status"], "approved");
    }

    #[tokio::test]
    async fn tcp_ensure_never_reuses_approval() {
        use crate::test_fixtures::test_router;

        let (app, _) = test_router("http://127.0.0.1:8787");
        let correlation = "tcp-correlation-1";
        let body = ensure_body(correlation);
        let req = Request::builder()
            .method("POST")
            .uri("/v1/cli/app-integration/ensure")
            .header("content-type", "application/json")
            .body(Body::from(body))
            .unwrap();
        let res = app.clone().oneshot(req).await.unwrap();
        let bytes = axum::body::to_bytes(res.into_body(), usize::MAX)
            .await
            .unwrap();
        let parsed: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(parsed["status"], "pending");
        let request_id = parsed["requestId"].as_str().expect("request id");
        let respond = Request::builder()
            .method("POST")
            .uri("/v1/cli/app-integration/respond")
            .header("content-type", "application/json")
            .body(Body::from(
                serde_json::json!({
                    "requestId": request_id,
                    "terminalSessionId": correlation,
                    "decision": "approve",
                })
                .to_string(),
            ))
            .unwrap();
        let res = app.clone().oneshot(respond).await.unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        let req = Request::builder()
            .method("POST")
            .uri("/v1/cli/app-integration/ensure")
            .header("content-type", "application/json")
            .body(Body::from(ensure_body(correlation)))
            .unwrap();
        let res = app.clone().oneshot(req).await.unwrap();
        let bytes = axum::body::to_bytes(res.into_body(), usize::MAX)
            .await
            .unwrap();
        let parsed: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(parsed["status"], "approved");
        let req = Request::builder()
            .method("POST")
            .uri("/v1/cli/app-integration/ensure")
            .header("content-type", "application/json")
            .body(Body::from(ensure_body(correlation)))
            .unwrap();
        let res = app.clone().oneshot(req).await.unwrap();
        let bytes = axum::body::to_bytes(res.into_body(), usize::MAX)
            .await
            .unwrap();
        let parsed: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(parsed["status"], "pending");
    }
}
