//! Organization-scoped outbound and reply ledgers share the lifecycle authorization boundary.
use super::{authorize_configure, internal, DEFAULT_DELIVERY_LIMIT};
use crate::{app_state::AppState, middleware::auth::resolve_caller_organization};
use axum::{
    extract::{Query, State},
    response::{IntoResponse, Response},
    Json,
};
use opensesame_lifecycle::MAX_DETAIL_CHARS;
use serde::Deserialize;
use serde_json::json;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DeliveryQuery {
    pub limit: Option<usize>,
}

/// `GET /api/v1/lifecycle/deliveries` — the outbound ledger.
pub async fn list_deliveries(
    State(st): State<AppState>,
    headers: axum::http::HeaderMap,
    Query(query): Query<DeliveryQuery>,
) -> Response {
    let who = match authorize_configure(&st, &headers) {
        Ok(who) => who,
        Err(response) => return response,
    };
    let organization_id = match resolve_caller_organization(&st, &who, &headers) {
        Ok(id) => id,
        Err(response) => return response,
    };
    let limit = query.limit.unwrap_or(DEFAULT_DELIVERY_LIMIT);
    let replies = match st
        .db
        .list_a2h_reply_status(&organization_id.to_string(), limit)
        .await
    {
        Ok(replies) => replies,
        Err(error) => return internal(&error, "list reply outcomes"),
    };
    match st
        .db
        .list_security_deliveries(&organization_id.to_string(), limit)
        .await
    {
        Ok(deliveries) => Json(json!({
            "replies": replies,
            "deliveries": deliveries
                .iter()
                .map(|row| json!({
                    "id": row.id,
                    "hook_id": row.hook_id,
                    "event_type": row.event_type,
                    "subject_kind": row.subject_kind,
                    "subject_id": row.subject_id,
                    "state": row.state,
                    "attempts": row.attempts,
                    "available_at": row.available_at,
                    "last_error": row.last_error.as_deref()
                        .map(|error| error.chars().take(MAX_DETAIL_CHARS).collect::<String>()),
                    "delivered_at": row.delivered_at,
                    "created_at": row.created_at,
                }))
                .collect::<Vec<_>>(),
            "secrets_returned": false,
        }))
        .into_response(),
        Err(error) => internal(&error, "list lifecycle deliveries"),
    }
}
