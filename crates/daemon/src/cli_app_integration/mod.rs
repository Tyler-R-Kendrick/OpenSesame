//! CLI app-integration routes (`/v1/cli/app-integration/*`).
use axum::{
    body::Body,
    extract::{FromRequest, State},
    http::{header, HeaderMap, HeaderValue, Method, Request, StatusCode},
    middleware::Next,
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use opensesame_cli_app_integration::{session_id_from_pid, CliAppIntegrationHost};
use serde::Deserialize;
use serde_json::json;
use std::sync::{Arc, Mutex};

use axum::extract::connect_info::ConnectInfo;
use axum::Extension;
use std::net::SocketAddr;

use crate::peer_auth::UdsConnectInfo;
use crate::{App, UdsPeer};

mod pairing_routes;
pub(crate) use pairing_routes::{
    pairing_confirm, pairing_exchange, pairing_issue_operator, pairing_revoke,
};

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
            "/v1/cli/app-integration/pairing/confirm",
            post(pairing_confirm),
        )
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

fn terminal_session_for_ensure(
    host: &mut opensesame_cli_app_integration::CliAppIntegrationHost,
    uds: &UdsPeer,
    tcp_peer: Option<ConnectInfo<SocketAddr>>,
) -> (String, bool) {
    #[cfg(unix)]
    if let Some(Extension(ConnectInfo(UdsConnectInfo(cred)))) = uds.as_ref() {
        if let Some(cred) = cred {
            if let Some(derived) = session_id_from_pid(cred.pid) {
                return (derived, true);
            }
        }
    }
    let peer_key = tcp_peer
        .map(|ConnectInfo(addr)| format!("tcp:{addr}"))
        .unwrap_or_else(|| {
            format!(
                "tcp:anon-{}",
                chrono::Utc::now().timestamp_nanos_opt().unwrap_or(0)
            )
        });
    let (id, _) = host.terminal_session_for_tcp(&peer_key);
    // TCP never auto-reuses an approved session (consume-on-next-ensure), same as pre-D5-3 body correlation.
    (id, false)
}

pub(crate) async fn ensure(State(st): State<App>, request: Request<Body>) -> Response {
    let uds: UdsPeer = request
        .extensions()
        .get::<ConnectInfo<UdsConnectInfo>>()
        .cloned()
        .map(Extension);
    let tcp_peer = request.extensions().get::<ConnectInfo<SocketAddr>>().cloned();
    let Json(req) = match Json::<EnsureReq>::from_request(request, &()).await {
        Ok(json) => json,
        Err(rejection) => return rejection.into_response(),
    };
    let mut host = match st.cli_app_integration.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };
    host.store
        .set_now_ms(chrono::Utc::now().timestamp_millis() as u64);
    let (terminal_session_id, reuse) = terminal_session_for_ensure(&mut host, &uds, tcp_peer);
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
    let pairing_secret = bearer(&headers).unwrap_or("");
    let status = match req.decision.as_str() {
        "approve" => {
            let proof = req.human_proof.as_deref().unwrap_or("");
            host.store.approve(
                &req.request_id,
                &req.terminal_session_id,
                &req.respond_nonce,
                proof,
                pairing_secret,
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
mod tests;
