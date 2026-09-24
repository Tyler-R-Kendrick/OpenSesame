//! Who may ask for a rotation, and whose jobs a caller may see.
//!
//! Requesting a rotation is open to any member, but only for a connection the
//! caller owns: a connection belonging to someone else reads as absent, exactly
//! as it does on the connection routes. Attaching an `interval` writes a durable
//! policy, which is the owner/admin surface `PUT /api/v1/rotation/policies`
//! guards, so it takes the same role here. Members see only their own
//! connection jobs; owner/admin see the organization's.
use axum::{
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use opensesame_connection_broker::{RotationJob, RotationTarget};
use opensesame_domain::OrganizationId;
use serde_json::json;

use crate::app_state::AppState;
use crate::middleware::auth::Caller;

fn not_found() -> Response {
    (
        StatusCode::NOT_FOUND,
        Json(json!({"error": "connection_not_found"})),
    )
        .into_response()
}

async fn owns_connection(
    st: &AppState,
    who: &Caller,
    organization_id: &OrganizationId,
    connection_id: &str,
) -> bool {
    match st
        .connection_broker
        .owner_subject(organization_id, connection_id)
        .await
    {
        Ok(owner) => {
            matches!(who, Caller::Operator) || owner.is_some_and(|owner| who.owns_subject(&owner))
        }
        Err(_) => false,
    }
}

/// Refuses a request the caller may not make for `target`.
pub(super) async fn may_request(
    st: &AppState,
    who: &Caller,
    organization_id: &OrganizationId,
    target: &RotationTarget,
    schedules: bool,
) -> Result<(), Response> {
    if schedules && !who.can_configure_integrations() {
        return Err((
            StatusCode::FORBIDDEN,
            Json(json!({
                "error": "forbidden",
                "hint": "owner or admin role required to schedule a rotation policy"
            })),
        )
            .into_response());
    }
    match target {
        RotationTarget::Connection { connection_id }
            if !owns_connection(st, who, organization_id, connection_id).await =>
        {
            Err(not_found())
        }
        _ => Ok(()),
    }
}

/// True when `who` may see `job`.
pub(super) async fn may_see(
    st: &AppState,
    who: &Caller,
    organization_id: &OrganizationId,
    job: &RotationJob,
) -> bool {
    if who.can_configure_integrations() {
        return true;
    }
    match &job.target {
        RotationTarget::Connection { connection_id } => {
            owns_connection(st, who, organization_id, connection_id).await
        }
        RotationTarget::StorePath { .. } | RotationTarget::WebLogin { .. } => false,
    }
}
