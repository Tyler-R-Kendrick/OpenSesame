//! The per-request freshness guard: the "existing connection, later
//! operation denied" path.
//!
//! TLS verifies at the handshake. A connection that stays open — HTTP
//! keep-alive, HTTP/2 — would otherwise keep the identity it was verified
//! with indefinitely, past a rotation, a revocation or its own usable-until
//! bound. [`enforce_current_generation`] runs on every request and denies
//! when the peer's credential or trust generation is older than the current
//! one, the current generation is withdrawn, the usable-until bound has
//! passed, or the leaf thumbprint is denied (process-wide or by the
//! listener's own hook). Requests with no peer pass through: whether a peer
//! is *required* is the listener's policy and admission's decision, not this
//! guard's.

use std::sync::Arc;

use axum::extract::{Request, State};
use axum::http::{header, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use chrono::Utc;
use opensesame_domain::transport::TransportError;

use crate::generations::TransportGenerations;
use crate::provenance::PeerExtension;
use crate::server::DenyThumbprint;

/// The listener's per-connection denylist hook, inserted beside
/// [`PeerExtension`].
#[derive(Clone)]
pub struct PeerDenyHook(pub DenyThumbprint);

impl std::fmt::Debug for PeerDenyHook {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("PeerDenyHook(..)")
    }
}

/// Decide whether the request's peer evidence is still acceptable.
///
/// # Errors
///
/// `GenerationStale`, `EvidenceExpired`, `EvidenceRevoked`, or the
/// withdrawal reason of the current generation.
pub fn check_peer_freshness(
    generations: &TransportGenerations,
    req: &Request,
) -> Result<(), TransportError> {
    let Some(PeerExtension(peer)) = req.extensions().get::<PeerExtension>() else {
        return Ok(());
    };
    let current = generations.current();
    if let Some(reason) = &current.withdrawn {
        return Err(reason.clone());
    }
    if peer.credential_generation() < current.number || peer.trust_generation() < current.number {
        return Err(TransportError::GenerationStale);
    }
    if Utc::now() > peer.usable_until() {
        return Err(TransportError::EvidenceExpired);
    }
    let thumbprint = peer.leaf_thumbprint_sha256();
    if generations.is_denied(thumbprint) {
        return Err(TransportError::EvidenceRevoked);
    }
    if let Some(PeerDenyHook(hook)) = req.extensions().get::<PeerDenyHook>() {
        if hook(thumbprint) {
            return Err(TransportError::EvidenceRevoked);
        }
    }
    Ok(())
}

/// Render a denial: `403` with a JSON body carrying the stable code and a
/// `x-opensesame-transport-error` header, no other detail.
#[must_use]
pub fn deny_response(error: &TransportError) -> Response {
    let body = serde_json::json!({ "error": error.code() }).to_string();
    (
        StatusCode::FORBIDDEN,
        [
            (header::CONTENT_TYPE, "application/json".to_owned()),
            (
                header::HeaderName::from_static("x-opensesame-transport-error"),
                error.code().to_owned(),
            ),
        ],
        body,
    )
        .into_response()
}

/// Axum middleware. Install with
/// `Router::layer(axum::middleware::from_fn_with_state(generations, enforce_current_generation))`.
pub async fn enforce_current_generation(
    State(generations): State<Arc<TransportGenerations>>,
    req: Request,
    next: Next,
) -> Response {
    match check_peer_freshness(&generations, &req) {
        Ok(()) => next.run(req).await,
        Err(error) => {
            tracing::warn!(
                code = error.code(),
                "transport guard denied request on open connection"
            );
            deny_response(&error)
        }
    }
}
