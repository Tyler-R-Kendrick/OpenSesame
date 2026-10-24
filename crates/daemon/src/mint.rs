//! Daemon mint passthrough (ADR 0049 §4): `POST /v1/mint`.
//!
//! The helper binaries (`git-credential-opensesame` and friends) are thin UDS
//! clients with no credential handling of their own; this route is what they
//! call. It forwards to the gateway's `POST /api/v1/connections/{id}/mint`
//! via `operator_forward` — the daemon's own operator token, which never
//! leaves the loopback fence (`remote_host_api` denies a non-local
//! `OPENSESAME_HOST_API`) — and passes the gateway's status and body through
//! untouched.
//!
//! Auth depends on the transport (ADR 0138 §2). On the Unix socket the caller
//! is admitted by its kernel-attested peer credentials alone, the same check
//! as the agent-capability exchange (`agent_capability::require_peer`): an
//! `Origin` header is refused, an unattested peer is `503`, and a UID outside
//! `allowed_uids` is `401` even with a valid operator token. A helper therefore
//! holds no bearer, so a process that answered at the socket path in the
//! daemon's place would capture nothing that authorizes anything. Over TCP
//! the route is `require_operator`, exactly like `/v1/discover`. Every other
//! operator route still demands the token on the socket too.
//!
//! The mint response carries `derived_token` bytes — permitted only because
//! it is a provider-minted, short-lived, revocable derived token on a
//! connection whose owner opted into `materialization = derived_short_lived`
//! (ADR 0049 §1/§2/§6). The daemon does not inspect, cache, or log it; the
//! body crosses this route as opaque JSON. What it does log is the receipt:
//! the connection id, the gateway's status and the caller — the peer's UID
//! and pid on the socket, `operator` over TCP — since the gateway's mint body
//! has no field to carry the peer.

use axum::{
    extract::{ConnectInfo, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Extension, Json,
};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::{
    agent_capability, operator_forward, rate_limited, require_operator, App, RateKey, UdsPeer,
};

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
    /// The credential lifetime asked for, in seconds; an AWS mint honours it
    /// under its binding's cap (ADR 0213). Passed through uninterpreted.
    #[serde(default)]
    pub duration_seconds: Option<u32>,
}

/// Who a mint is for, once admitted.
enum Caller {
    /// A process on the Unix socket, by its kernel-attested credentials.
    Peer { uid: u32, pid: u32 },
    /// A TCP caller holding the operator token.
    Operator,
}

impl Caller {
    fn rate_key(&self) -> RateKey {
        match self {
            Self::Peer { uid, .. } => RateKey::Uid(*uid),
            Self::Operator => RateKey::TcpOperator,
        }
    }

    fn actor(&self) -> String {
        match self {
            Self::Peer { uid, pid } => format!("uid:{uid} pid:{pid}"),
            Self::Operator => "operator".to_string(),
        }
    }
}

/// Admit the caller: peer credentials on the socket, the operator token on
/// TCP (ADR 0138 §2).
#[allow(clippy::result_large_err)] // axum::Response is intentionally the Err payload
fn admit(st: &App, headers: &HeaderMap, uds: &UdsPeer) -> Result<Caller, Response> {
    if uds.is_none() {
        require_operator(st, headers, uds)?;
        return Ok(Caller::Operator);
    }
    let uid = agent_capability::require_peer(st, headers, uds)?;
    let pid = uds
        .as_ref()
        .and_then(|Extension(ConnectInfo(info))| info.0)
        .map_or(0, |cred| cred.pid);
    Ok(Caller::Peer { uid, pid })
}

/// `POST /v1/mint` — forward to the gateway mint route, pass the answer back.
pub async fn mint_via_daemon(
    State(st): State<App>,
    uds: UdsPeer,
    headers: HeaderMap,
    Json(req): Json<MintRequest>,
) -> Response {
    let caller = match admit(&st, &headers, &uds) {
        Ok(caller) => caller,
        Err(resp) => return resp,
    };
    if let Err(retry_after) = st.mint_limiter.check(caller.rate_key()) {
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
    let response = match forward.json(&body).send().await {
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
    };
    tracing::info!(
        target: "opensesame.receipt",
        connection_id = %req.connection_id,
        status = response.status().as_u16(),
        actor = %caller.actor(),
        "mint.receipt"
    );
    response
}

#[cfg(test)]
#[path = "mint_tests.rs"]
mod tests;
