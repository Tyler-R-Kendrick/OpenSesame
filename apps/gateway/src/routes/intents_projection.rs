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
use opensesame_provider_openfga::TupleKey;
use opensesame_storage::authority::ProjectionMark;
use serde_json::json;

use crate::app_state::AppState;

use super::intents::ResolvedInvocation;

const OPENFGA_STORE: &str = "openfga";

/// Authorize via OpenFGA only after the projection has caught up, or skip when
/// OpenFGA is not configured.
pub(super) async fn authorize_openfga(
    st: &AppState,
    organization_id: &str,
    subject: &str,
    resolved: &ResolvedInvocation,
) -> Result<(), Response> {
    let Some(openfga) = &st.openfga else {
        return Ok(());
    };
    require_projection_fresh(st, organization_id, resolved).await?;
    match openfga
        .check_tuple(&TupleKey {
            user: subject.into(),
            relation: "user".into(),
            object: "connection:demo-conn".into(),
        })
        .await
    {
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

async fn require_projection_fresh(
    st: &AppState,
    organization_id: &str,
    resolved: &ResolvedInvocation,
) -> Result<(), Response> {
    let grant_id = resolved.grant.id.to_string();
    let Ok(fenced) = st
        .db
        .fenced_authority(organization_id, &grant_id, Utc::now())
        .await
    else {
        return Err(projection_unavailable());
    };
    let Some(fenced) = fenced else {
        // Legacy / bootstrap grant: no generalized sidecar, no projection owed.
        return Ok(());
    };
    let mark = ProjectionMark {
        store: OPENFGA_STORE,
        organization_id,
        subject_kind: "grant",
        subject_id: &grant_id,
        committed_revision: fenced.revision,
    };
    let model_id: Option<&str> = None;
    match st.db.projection_applied(&mark, model_id).await {
        Ok(true) => Ok(()),
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
