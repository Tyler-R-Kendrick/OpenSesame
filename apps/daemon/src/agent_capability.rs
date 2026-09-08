//! UDS is transport identity, not operator authority. A launch handle is still required.
use super::{App, UdsPeer};
use axum::{
    extract::{ConnectInfo, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Extension, Json,
};
use serde::Deserialize;
use serde_json::json;

pub(super) fn require_peer(st: &App, headers: &HeaderMap, peer: &UdsPeer) -> Result<u32, Response> {
    if headers.contains_key("origin") {
        return Err(StatusCode::UNAUTHORIZED.into_response());
    }
    let Some(Extension(ConnectInfo(info))) = peer else {
        return Err(StatusCode::UNAUTHORIZED.into_response());
    };
    let Some(cred) = info.0 else {
        return Err((
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({"error":"uds_peer_unattested"})),
        )
            .into_response());
    };
    opensesame_uds_authn::authorize(&cred, &st.allowed_uids)
        .map(|()| cred.uid)
        .map_err(|_| {
            (
                StatusCode::UNAUTHORIZED,
                Json(json!({"error":"uds_peer_unauthorized"})),
            )
                .into_response()
        })
}

#[derive(Deserialize, serde::Serialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Exchange {
    launch_handle: String,
    client_id: String,
    audience: String,
}

pub(super) async fn exchange(
    State(st): State<App>,
    peer: UdsPeer,
    headers: HeaderMap,
    Json(req): Json<Exchange>,
) -> Response {
    if let Err(response) = require_peer(&st, &headers, &peer) {
        return response;
    }
    if req.launch_handle.len() != 64
        || !req.launch_handle.bytes().all(|b| b.is_ascii_hexdigit())
        || req.client_id.len() > 128
        || req.audience.len() > 128
    {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let url = format!(
        "{}/api/v1/agent-launches/token",
        st.host_api.trim_end_matches('/')
    );
    // Only the approved single-use handle is forwarded, never an operator header.
    let response = st
        .http
        .post(url)
        .timeout(std::time::Duration::from_secs(5))
        .json(&req)
        .send()
        .await;
    let Ok(mut response) = response else {
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    };
    if !response.status().is_success() {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    if response.content_length().is_some_and(|size| size > 8192) {
        return StatusCode::BAD_GATEWAY.into_response();
    }
    let mut bytes = Vec::new();
    loop {
        match response.chunk().await {
            Ok(Some(chunk)) if chunk.len() <= 8192 - bytes.len() => bytes.extend_from_slice(&chunk),
            Ok(None) => break,
            _ => return StatusCode::BAD_GATEWAY.into_response(),
        }
    }
    (
        [
            ("content-type", "application/json"),
            ("cache-control", "no-store"),
        ],
        bytes,
    )
        .into_response()
}
