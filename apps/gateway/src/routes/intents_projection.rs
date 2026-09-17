//! OpenFGA freshness fence on the invoke path (INV-CONSISTENCY).
//!
//! A projection is never the ledger. When OpenFGA is configured, the Host must
//! refuse to authorize from a stale or missing projection rather than treat
//! "unknown" as fresh. Bootstrap grants without a generalized authority sidecar
//! skip this fence — they never wrote a projection row to catch up to.

use axum::{
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use chrono::Utc;
use opensesame_provider_openfga::invoke_check_tuple;
use opensesame_storage::authority::ProjectionMark;
use serde_json::json;

use crate::app_state::AppState;

use super::intents::ResolvedInvocation;

const OPENFGA_STORE: &str = "openfga";

/// Authorize via OpenFGA only after the projection has caught up, or skip when
/// OpenFGA is not configured. Bootstrap grants without a sidecar skip entirely.
pub(super) async fn authorize_openfga(
    st: &AppState,
    organization_id: &str,
    subject: &str,
    resolved: &ResolvedInvocation,
    operation: &str,
    resource: &str,
) -> Result<(), Response> {
    if !require_projection_fresh(st, organization_id, resolved).await? {
        return Ok(());
    }
    let Some(openfga) = &st.openfga else {
        return Ok(());
    };
    let connection = resolved.connection_id.to_string();
    let tuple = match invoke_check_tuple(subject, operation, resource, Some(connection.as_str())) {
        Ok(tuple) => tuple,
        Err(_) => {
            return Err((
                StatusCode::FORBIDDEN,
                Json(json!({"error": "openfga_unmapped", "type": "about:blank"})),
            )
                .into_response());
        }
    };
    match openfga.check_tuple(&tuple).await {
        Ok(true) => Ok(()),
        Ok(false) => Err((
            StatusCode::FORBIDDEN,
            Json(json!({"error": "openfga_denied", "type": "about:blank"})),
        )
            .into_response()),
        Err(error) => {
            tracing::warn!(%error, "openfga check failed");
            Err((
                StatusCode::SERVICE_UNAVAILABLE,
                Json(json!({"error": "openfga_unavailable", "type": "about:blank"})),
            )
                .into_response())
        }
    }
}

/// `Ok(false)` means no sidecar (legacy/bootstrap): skip OpenFGA.
async fn require_projection_fresh(
    st: &AppState,
    organization_id: &str,
    resolved: &ResolvedInvocation,
) -> Result<bool, Response> {
    let grant_id = resolved.grant.id.to_string();
    let Ok(fenced) = st
        .db
        .fenced_authority(organization_id, &grant_id, Utc::now())
        .await
    else {
        return Err(projection_unavailable());
    };
    let Some(fenced) = fenced else {
        return match st
            .db
            .authority_sidecar_present(organization_id, &grant_id)
            .await
        {
            Ok(false) => Ok(false),
            Ok(true) => Err(projection_stale()),
            Err(_) => Err(projection_unavailable()),
        };
    };
    let mark = ProjectionMark {
        store: OPENFGA_STORE,
        organization_id,
        subject_kind: "grant",
        subject_id: &grant_id,
        committed_revision: fenced.revision,
    };
    match st.db.projection_applied(&mark, None).await {
        Ok(true) => Ok(true),
        Ok(false) => Err(projection_stale()),
        Err(_) => Err(projection_unavailable()),
    }
}

fn projection_stale() -> Response {
    (
        StatusCode::FORBIDDEN,
        Json(json!({
            "error": "projection_stale",
            "detail": "OpenFGA projection has not caught up to the authority revision",
            "type": "about:blank"
        })),
    )
        .into_response()
}

fn projection_unavailable() -> Response {
    (
        StatusCode::SERVICE_UNAVAILABLE,
        Json(json!({
            "error": "projection_unavailable",
            "type": "about:blank"
        })),
    )
        .into_response()
}

#[cfg(test)]
#[path = "intents_projection_tests.rs"]
mod tests;
