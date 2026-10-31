//! `PUT | GET | DELETE /api/v1/connections/{id}/aws-sts-binding` (ADR 0217):
//! the STS role an aws-family connection mints for, and the bounds every mint
//! stays inside. Administrator-only, like the mint itself. Answers are
//! value-blind: the `ExternalId` goes in and never comes back out.

use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use opensesame_connection_broker::aws_sts::AwsStsBindingInput;
use serde_json::json;

use super::{authorize, broker_error, caller_organization, owned, require_integration_admin};
use crate::app_state::AppState;
use crate::middleware::auth::Caller;

/// The binding body. Its fields are required, so an empty body is refused,
/// and a parse failure answers a fixed sentence: serde's own message can quote
/// the value it rejected, which here may be the `ExternalId`.
#[allow(clippy::result_large_err)]
fn parse_input(raw: &str) -> Result<AwsStsBindingInput, Response> {
    if raw.len() > 32 * 1024 {
        return Err((
            StatusCode::PAYLOAD_TOO_LARGE,
            Json(json!({"error": "invalid_request", "hint": "request body exceeds 32 KiB"})),
        )
            .into_response());
    }
    serde_json::from_str(raw).map_err(|_| {
        (
            StatusCode::BAD_REQUEST,
            Json(json!({"error": "invalid_request", "hint": "request body is not an STS binding"})),
        )
            .into_response()
    })
}

/// Caller, organization, ownership and admin role, in that order.
#[allow(clippy::result_large_err)]
async fn admitted(
    st: &AppState,
    headers: &axum::http::HeaderMap,
    id: &str,
) -> Result<(Caller, opensesame_domain::OrganizationId), Response> {
    let who = authorize(st, headers)?;
    let organization_id = caller_organization(st, &who, headers)?;
    owned(st, &who, &organization_id, id).await?;
    require_integration_admin(&who)?;
    Ok((who, organization_id))
}

pub async fn put_aws_sts_binding(
    State(st): State<AppState>,
    headers: axum::http::HeaderMap,
    Path(id): Path<String>,
    body: String,
) -> Response {
    let (_, organization_id) = match admitted(&st, &headers, &id).await {
        Ok(admitted) => admitted,
        Err(response) => return response,
    };
    let input: AwsStsBindingInput = match parse_input(&body) {
        Ok(input) => input,
        Err(response) => return response,
    };
    match st
        .connection_broker
        .put_aws_sts_binding(&organization_id, &id, input)
        .await
    {
        Ok(view) => Json(view).into_response(),
        Err(error) => broker_error(&error),
    }
}

pub async fn get_aws_sts_binding(
    State(st): State<AppState>,
    headers: axum::http::HeaderMap,
    Path(id): Path<String>,
) -> Response {
    let (_, organization_id) = match admitted(&st, &headers, &id).await {
        Ok(admitted) => admitted,
        Err(response) => return response,
    };
    match st
        .connection_broker
        .aws_sts_binding(&organization_id, &id)
        .await
    {
        Ok(Some(view)) => Json(view).into_response(),
        Ok(None) => (
            StatusCode::NOT_FOUND,
            Json(json!({"error": "binding_not_found", "hint": "binding not found"})),
        )
            .into_response(),
        Err(error) => broker_error(&error),
    }
}

pub async fn delete_aws_sts_binding(
    State(st): State<AppState>,
    headers: axum::http::HeaderMap,
    Path(id): Path<String>,
) -> Response {
    let (_, organization_id) = match admitted(&st, &headers, &id).await {
        Ok(admitted) => admitted,
        Err(response) => return response,
    };
    match st
        .connection_broker
        .delete_aws_sts_binding(&organization_id, &id)
        .await
    {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(error) => broker_error(&error),
    }
}
