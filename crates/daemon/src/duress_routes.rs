//! The daemon's duress peer routes: the receiver's responses, served only
//! after the operator / UDS gate (`require_operator`).

use axum::{
    body::Bytes,
    extract::State,
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
};

use crate::{duress_receiver, require_operator, App, UdsPeer};

/// `GET /v1/duress/peer/health`.
pub(crate) async fn duress_peer_health(
    State(st): State<App>,
    uds: UdsPeer,
    headers: HeaderMap,
) -> Response {
    require_operator(&st, &headers, &uds)
        .err()
        .unwrap_or_else(|| duress_receiver::peer_health_response(st.duress_peer.as_ref()))
}

/// `POST /v1/duress/peer/envelope`: 404 when no peer receiver is configured.
pub(crate) async fn duress_peer_envelope(
    State(st): State<App>,
    uds: UdsPeer,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    if let Err(resp) = require_operator(&st, &headers, &uds) {
        return resp;
    }
    match st.duress_peer.as_ref() {
        Some(peer) => duress_receiver::receive_envelope_response(peer, &headers, &body),
        None => StatusCode::NOT_FOUND.into_response(),
    }
}
