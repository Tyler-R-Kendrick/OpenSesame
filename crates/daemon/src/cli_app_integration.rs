//! CLI app-integration routes (`/v1/cli/app-integration/*`).
use axum::{
    extract::State,
    http::{header, HeaderMap, HeaderValue, Method, StatusCode},
    middleware::Next,
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use opensesame_cli_app_integration::{
    format_pairing_code, is_pairable_origin, session_id_from_pid, CliAppIntegrationHost,
    PairingError,
};
use sha2::Digest;
use serde::Deserialize;
use serde_json::json;
use std::sync::{Arc, Mutex};

use axum::extract::connect_info::ConnectInfo;
use axum::Extension;

use crate::peer_auth::UdsConnectInfo;
use crate::{require_operator, App, UdsPeer};

pub(crate) type SharedCliAppIntegration = Arc<Mutex<CliAppIntegrationHost>>;

pub(crate) fn fresh_store() -> SharedCliAppIntegration {
    opensesame_cli_app_integration::fresh_host()
}

fn origin_of(headers: &HeaderMap) -> Option<&str> {
    headers.get(header::ORIGIN)?.to_str().ok()
}

fn bearer(headers: &HeaderMap) -> Option<&str> {
    headers
        .get(header::AUTHORIZATION)?
        .to_str()
        .ok()?
        .strip_prefix("Bearer ")
}

fn pairing_error(status: StatusCode, code: &str) -> Response {
    (status, Json(json!({ "error": code }))).into_response()
}

fn require_paired_caller(st: &App, headers: &HeaderMap) -> Result<(), Response> {
    let Some(origin) = origin_of(headers) else {
        return Err(pairing_error(StatusCode::FORBIDDEN, "origin_required"));
    };
    let Some(token) = bearer(headers) else {
        return Err(pairing_error(StatusCode::UNAUTHORIZED, "cli_app_pairing_required"));
    };
    let host = st.cli_app_integration.lock().map_err(|_| {
        pairing_error(StatusCode::INTERNAL_SERVER_ERROR, "cli_app_integration_locked")
    })?;
    if host.pairings.authorizes(token, origin) {
        Ok(())
    } else {
        Err(pairing_error(StatusCode::UNAUTHORIZED, "cli_app_pairing_required"))
    }
}

pub(crate) fn routes(app: &App) -> Router<App> {
    let browser = Router::new()
        .route("/v1/cli/app-integration/pending", get(pending))
        .route("/v1/cli/app-integration/respond", post(respond))
        .route(
            "/v1/cli/app-integration/pairing",
            post(pairing_exchange).delete(pairing_revoke),
        )
        .layer(axum::middleware::from_fn_with_state(app.clone(), cors));
    Router::new()
        .route("/v1/cli/app-integration/ensure", post(ensure))
        .route(
            "/v1/operator/cli-app-integration/pair",
            post(pairing_issue_operator),
        )
        .merge(browser)
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
    respond_nonce: String,
    human_proof: Option<String>,
}

#[derive(Debug, Deserialize)]
struct PairingExchange {
    code: String,
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
    let mut host = match st.cli_app_integration.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };
    host.store
        .set_now_ms(chrono::Utc::now().timestamp_millis() as u64);
    let (terminal_session_id, reuse) = terminal_session_for_ensure(&uds, &req);
    let (status, request_id) = host.store.ensure(
        &terminal_session_id,
        &req.verb,
        req.reference.as_deref(),
        reuse,
    );
    Json(json!({ "status": status, "requestId": request_id })).into_response()
}

pub(crate) async fn pending(State(st): State<App>, headers: HeaderMap) -> Response {
    if let Err(resp) = require_paired_caller(&st, &headers) {
        return resp;
    }
    let mut host = match st.cli_app_integration.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };
    host.store
        .set_now_ms(chrono::Utc::now().timestamp_millis() as u64);
    let rows = host
        .store
        .list_pending()
        .into_iter()
        .map(|row| {
            json!({
                "requestId": row.request_id,
                "terminalSessionId": row.terminal_session_id,
                "verb": row.verb,
                "reference": row.reference,
                "respondNonce": row.respond_nonce,
            })
        })
        .collect::<Vec<_>>();
    Json(json!({ "pending": rows })).into_response()
}

pub(crate) async fn respond(
    State(st): State<App>,
    headers: HeaderMap,
    Json(req): Json<RespondReq>,
) -> Response {
    if let Err(resp) = require_paired_caller(&st, &headers) {
        return resp;
    }
    let mut host = match st.cli_app_integration.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };
    host.store
        .set_now_ms(chrono::Utc::now().timestamp_millis() as u64);
    let status = match req.decision.as_str() {
        "approve" => {
            let proof = req.human_proof.as_deref().unwrap_or("");
            host.store.approve(
                &req.request_id,
                &req.terminal_session_id,
                &req.respond_nonce,
                proof,
            )
        }
        "deny" => host.store.deny(
            &req.request_id,
            &req.terminal_session_id,
            &req.respond_nonce,
        ),
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

pub(crate) async fn pairing_exchange(
    State(st): State<App>,
    headers: HeaderMap,
    Json(body): Json<PairingExchange>,
) -> Response {
    let Some(origin) = origin_of(&headers).filter(|o| is_pairable_origin(o)) else {
        return pairing_error(StatusCode::FORBIDDEN, "origin_required");
    };
    let now = chrono::Utc::now().timestamp() as u64;
    let mut host = match st.cli_app_integration.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };
    match host.pairings.exchange(&body.code, origin, now) {
        Ok(issued) => (
            StatusCode::CREATED,
            Json(json!({
                "id": issued.id,
                "origin": issued.origin,
                "token": issued.token,
            })),
        )
            .into_response(),
        Err(PairingError::WrongOrigin) => {
            pairing_error(StatusCode::FORBIDDEN, "pairing_refused")
        }
        Err(PairingError::Unknown | PairingError::Expired | PairingError::InvalidOrigin) => {
            pairing_error(StatusCode::FORBIDDEN, "pairing_refused")
        }
        Err(PairingError::Full) => pairing_error(StatusCode::CONFLICT, "too_many_pairings"),
    }
}

pub(crate) async fn pairing_revoke(State(st): State<App>, headers: HeaderMap) -> Response {
    let (Some(origin), Some(token)) = (origin_of(&headers), bearer(&headers)) else {
        return pairing_error(StatusCode::UNAUTHORIZED, "cli_app_pairing_required");
    };
    let mut host = match st.cli_app_integration.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };
    let digest = sha2::Sha256::digest(token.as_bytes());
    let digest_hex = hex::encode(digest);
    let before = host.pairings.paired_len();
    host.pairings.revoke_token(origin, &digest_hex);
    if host.pairings.paired_len() < before {
        StatusCode::NO_CONTENT.into_response()
    } else {
        pairing_error(StatusCode::UNAUTHORIZED, "cli_app_pairing_required")
    }
}

/// Operator-only: mint a pairing code for a browser origin (terminal prints it).
pub(crate) async fn pairing_issue_operator(
    State(st): State<App>,
    headers: HeaderMap,
    uds: UdsPeer,
    Json(body): Json<PairingIssueReq>,
) -> Response {
    if let Err(resp) = require_operator(&st, &headers, &uds) {
        return resp;
    }
    if !is_pairable_origin(&body.origin) {
        return pairing_error(StatusCode::BAD_REQUEST, "invalid_origin");
    }
    let now = chrono::Utc::now().timestamp() as u64;
    let mut host = match st.cli_app_integration.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };
    match host.pairings.issue(&body.origin, now) {
        Ok((code, expires_at)) => {
            let url = body
                .url
                .as_deref()
                .unwrap_or("http://127.0.0.1:18790");
            let label = body.label.as_deref().unwrap_or("CLI");
            Json(json!({
                "pairingCode": format_pairing_code(url, &code, &body.origin, label),
                "origin": body.origin,
                "expiresAt": expires_at,
            }))
            .into_response()
        }
        Err(PairingError::Full) => pairing_error(StatusCode::CONFLICT, "too_many_pairings"),
        Err(PairingError::InvalidOrigin) => {
            pairing_error(StatusCode::BAD_REQUEST, "invalid_origin")
        }
        Err(
            PairingError::Unknown | PairingError::Expired | PairingError::WrongOrigin,
        ) => pairing_error(StatusCode::INTERNAL_SERVER_ERROR, "pairing_refused"),
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PairingIssueReq {
    origin: String,
    url: Option<String>,
    label: Option<String>,
}

const ALLOW_METHODS: &str = "GET, POST, DELETE";
const ALLOW_HEADERS: &str = "authorization, content-type";
const PREFLIGHT_MAX_AGE: &str = "600";

fn allow(response: &mut Response, origin: Option<&str>) {
    let headers = response.headers_mut();
    headers.append(header::VARY, HeaderValue::from_static("Origin"));
    if let Some(value) = origin.and_then(|o| HeaderValue::from_str(o).ok()) {
        headers.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, value);
    }
}

async fn cors(State(st): State<App>, request: axum::http::Request<axum::body::Body>, next: Next) -> Response {
    let Some(origin) = origin_of(request.headers()).map(str::to_owned) else {
        return next.run(request).await;
    };
    let admitted = st
        .cli_app_integration
        .lock()
        .map(|host| host.pairings.admits_origin(&origin, chrono::Utc::now().timestamp() as u64))
        .unwrap_or(false)
        .then_some(origin);
    if request.method() == Method::OPTIONS
        && request
            .headers()
            .contains_key(header::ACCESS_CONTROL_REQUEST_METHOD)
    {
        let status = if admitted.is_some() {
            StatusCode::NO_CONTENT
        } else {
            StatusCode::FORBIDDEN
        };
        let mut response = status.into_response();
        allow(&mut response, admitted.as_deref());
        if admitted.is_some() {
            let headers = response.headers_mut();
            for (name, value) in [
                (header::ACCESS_CONTROL_ALLOW_METHODS, ALLOW_METHODS),
                (header::ACCESS_CONTROL_ALLOW_HEADERS, ALLOW_HEADERS),
                (header::ACCESS_CONTROL_MAX_AGE, PREFLIGHT_MAX_AGE),
            ] {
                headers.insert(name, HeaderValue::from_static(value));
            }
        }
        return response;
    }
    let mut response = next.run(request).await;
    allow(&mut response, admitted.as_deref());
    response
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

    fn pair_browser(app: &App, origin: &str) -> String {
        let now = chrono::Utc::now().timestamp() as u64;
        let (code, _) = app
            .cli_app_integration
            .lock()
            .unwrap()
            .pairings
            .issue(origin, now)
            .unwrap();
        app.cli_app_integration
            .lock()
            .unwrap()
            .pairings
            .exchange(&code, origin, now)
            .unwrap()
            .token
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

        let (app, state) = test_router("http://127.0.0.1:8787");
        let origin = "http://localhost:5180";
        let token = pair_browser(&state, origin);
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
        let pending = Request::builder()
            .method("GET")
            .uri("/v1/cli/app-integration/pending")
            .header(header::ORIGIN, origin)
            .header(header::AUTHORIZATION, format!("Bearer {token}"))
            .body(Body::empty())
            .unwrap();
        let res = app.clone().oneshot(pending).await.unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        let bytes = axum::body::to_bytes(res.into_body(), usize::MAX)
            .await
            .unwrap();
        let parsed: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        let nonce = parsed["pending"][0]["respondNonce"]
            .as_str()
            .expect("nonce");
        let respond = Request::builder()
            .method("POST")
            .uri("/v1/cli/app-integration/respond")
            .header("content-type", "application/json")
            .header(header::ORIGIN, origin)
            .header(header::AUTHORIZATION, format!("Bearer {token}"))
            .body(Body::from(
                serde_json::json!({
                    "requestId": request_id,
                    "terminalSessionId": derived,
                    "decision": "approve",
                    "respondNonce": nonce,
                    "humanProof": "human-proof-from-test-harness",
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
    async fn pending_without_pairing_is_unauthorized() {
        use crate::test_fixtures::test_router;

        let (app, _) = test_router("http://127.0.0.1:8787");
        let pending = Request::builder()
            .method("GET")
            .uri("/v1/cli/app-integration/pending")
            .header(header::ORIGIN, "http://localhost:5180")
            .body(Body::empty())
            .unwrap();
        let res = app.oneshot(pending).await.unwrap();
        assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn tcp_ensure_never_reuses_approval() {
        use crate::test_fixtures::test_router;

        let (app, state) = test_router("http://127.0.0.1:8787");
        let origin = "http://localhost:5180";
        let token = pair_browser(&state, origin);
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
        let pending = Request::builder()
            .method("GET")
            .uri("/v1/cli/app-integration/pending")
            .header(header::ORIGIN, origin)
            .header(header::AUTHORIZATION, format!("Bearer {token}"))
            .body(Body::empty())
            .unwrap();
        let res = app.clone().oneshot(pending).await.unwrap();
        let bytes = axum::body::to_bytes(res.into_body(), usize::MAX)
            .await
            .unwrap();
        let parsed: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        let nonce = parsed["pending"][0]["respondNonce"]
            .as_str()
            .expect("nonce");
        let respond = Request::builder()
            .method("POST")
            .uri("/v1/cli/app-integration/respond")
            .header("content-type", "application/json")
            .header(header::ORIGIN, origin)
            .header(header::AUTHORIZATION, format!("Bearer {token}"))
            .body(Body::from(
                serde_json::json!({
                    "requestId": request_id,
                    "terminalSessionId": correlation,
                    "decision": "approve",
                    "respondNonce": nonce,
                    "humanProof": "human-proof-from-test-harness",
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
