//! Daemon mint passthrough (ADR 0049 §4): `POST /v1/mint`.
//!
//! The helper binaries (`git-credential-opensesame` and friends) are thin UDS
//! clients with no credential handling of their own; this route is what they
//! call. It forwards to the gateway's `POST /api/v1/connections/{id}/mint`
//! via `operator_forward` — the operator token never leaves the loopback
//! fence (`remote_host_api` denies a non-local `OPENSESAME_HOST_API`) — and
//! passes the gateway's status and body through untouched.
//!
//! Auth is `require_operator` exactly like `/v1/discover`: the operator
//! bearer token is required on every transport, and over the UDS the
//! kernel-attested peer UID is an additional transport restriction.
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

/// The request is two short strings and a number; anything larger is junk.
pub const MAX_BODY_BYTES: usize = 4 * 1024;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MintRequest {
    pub connection_id: String,
    /// GitHub App installation id; required for github connections, passed
    /// through uninterpreted.
    #[serde(default)]
    pub installation_id: Option<String>,
    /// The credential lifetime asked for, in seconds; an AWS mint honours it
    /// under its binding's cap (ADR 0207). Passed through uninterpreted.
    #[serde(default)]
    pub duration_seconds: Option<u32>,
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
    if let Some(duration_seconds) = req.duration_seconds {
        body["duration_seconds"] = json!(duration_seconds);
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
                "hint": "is Host API up on OPENSESAME_HOST_API?"
            })),
        )
            .into_response(),
    }
}

#[cfg(test)]
#[path = "mint_tests.rs"]
mod tests;
