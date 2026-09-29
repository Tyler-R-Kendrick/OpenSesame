//! The human's half of the pairing ceremony (ADR 0052 §2 (b)).
//!
//! Approve, revoke and list take the operator credential exactly like every
//! other mutating daemon route, and `require_operator` refuses any request
//! that carries an `Origin` — so no web page, and no extension, can approve
//! its own pairing. A person reads the code in the extension's popup and
//! approves it here:
//!
//! ```text
//! curl -s -H "X-OpenSesame-Operator: $OPENSESAME_OPERATOR_TOKEN" \
//!   -H 'content-type: application/json' -d '{"code":"ABCD-EFGH"}' \
//!   http://127.0.0.1:18790/v1/fill/pair/approve
//! ```

use super::{caller::refuse, pairing::PairingError, FillState};
use crate::{require_operator, App, UdsPeer};
use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Extension, Json,
};
use serde::Deserialize;
use serde_json::json;
use std::sync::Arc;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct ApproveReq {
    code: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct RevokeReq {
    origin: String,
}

fn pairing_failed(error: &PairingError) -> Response {
    match error {
        PairingError::Full => refuse(StatusCode::CONFLICT, "too_many_paired"),
        PairingError::Io(io) => {
            tracing::warn!(error = %io, "fill pairing file could not be written");
            refuse(StatusCode::INTERNAL_SERVER_ERROR, "pairing_not_saved")
        }
    }
}

/// `POST /v1/fill/pair/approve`: the code a person read off their popup.
pub(super) async fn approve(
    State(st): State<App>,
    uds: UdsPeer,
    Extension(fill): Extension<Arc<FillState>>,
    headers: HeaderMap,
    Json(req): Json<ApproveReq>,
) -> Response {
    if let Err(response) = require_operator(&st, &headers, &uds) {
        return response;
    }
    match fill.pairings.approve(&req.code, chrono::Utc::now()) {
        Ok(Some(origin)) => {
            tracing::info!(%origin, "fill: extension paired");
            Json(json!({ "paired": true, "origin": origin })).into_response()
        }
        Ok(None) => refuse(StatusCode::NOT_FOUND, "unknown_code"),
        Err(error) => pairing_failed(&error),
    }
}

/// `POST /v1/fill/pair/revoke`: forget one paired extension.
pub(super) async fn revoke(
    State(st): State<App>,
    uds: UdsPeer,
    Extension(fill): Extension<Arc<FillState>>,
    headers: HeaderMap,
    Json(req): Json<RevokeReq>,
) -> Response {
    if let Err(response) = require_operator(&st, &headers, &uds) {
        return response;
    }
    match fill.pairings.revoke(&req.origin) {
        Ok(revoked) => {
            if revoked {
                tracing::info!(origin = %req.origin, "fill: extension pairing revoked");
            }
            Json(json!({ "revoked": revoked })).into_response()
        }
        Err(error) => pairing_failed(&error),
    }
}

/// `GET /v1/fill/pairings`: paired origins and live codes, never digests.
pub(super) async fn list(
    State(st): State<App>,
    uds: UdsPeer,
    Extension(fill): Extension<Arc<FillState>>,
    headers: HeaderMap,
) -> Response {
    if let Err(response) = require_operator(&st, &headers, &uds) {
        return response;
    }
    let (paired, pending) = fill.pairings.snapshot(chrono::Utc::now());
    Json(json!({ "paired": paired, "pending": pending })).into_response()
}
