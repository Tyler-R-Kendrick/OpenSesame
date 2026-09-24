//! Count- and byte-bounded ciphertext pages. The Host never decrypts them.
use crate::{
    app_state::AppState,
    middleware::auth::{require_session, session_subject},
};
use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use serde_json::json;

pub(super) fn routes() -> axum::Router<AppState> {
    use super::{sync, sync_blobs};
    use axum::{extract::DefaultBodyLimit, routing::post, Router};
    Router::new()
        .route(
            "/api/v1/sync/push",
            post(sync::push).layer(DefaultBodyLimit::max(10 * 1024 * 1024)),
        )
        .route(
            "/api/v1/sync/pull-page",
            post(pull_page).layer(DefaultBodyLimit::max(32 * 1024)),
        )
        .route("/api/v1/sync/pull", post(sync::pull))
        .route(
            "/api/v1/sync/blobs/snapshot",
            post(sync_blobs::snapshot).layer(DefaultBodyLimit::max(32 * 1024)),
        )
        .route(
            "/api/v1/sync/blobs/push",
            post(sync_blobs::push_opaque).layer(DefaultBodyLimit::max(1024 * 1024)),
        )
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Cursor {
    pub epoch: u64,
    pub id: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PageQuery {
    #[serde(default)]
    pub after: Option<Cursor>,
    #[serde(default)]
    pub limit: Option<u32>,
    #[serde(default)]
    pub device_id: Option<String>,
}

pub async fn pull_page(
    State(st): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<PageQuery>,
) -> Response {
    serve_page(&st, &headers, body, false, None).await
}

pub(super) async fn serve_page(
    st: &AppState,
    headers: &HeaderMap,
    body: PageQuery,
    legacy: bool,
    project: Option<String>,
) -> Response {
    let (owner, organization) = match require_session(st, headers) {
        Ok((_, claims)) => (session_subject(&claims), claims.organization_id.to_string()),
        Err(response) => return response,
    };
    let limit = body.limit.unwrap_or(32);
    let after = body.after.unwrap_or(Cursor {
        epoch: 0,
        id: String::new(),
    });
    if !(1..=64).contains(&limit)
        || after.id.len() > 128
        || after.epoch > i64::MAX as u64
        || body
            .device_id
            .as_ref()
            .is_some_and(|id| id.is_empty() || id.len() > 128)
        || project
            .as_ref()
            .is_some_and(|id| id.is_empty() || id.len() > 128)
    {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error":"invalid_sync_cursor"})),
        )
            .into_response();
    }
    let Ok((stored, has_more)) = st
        .db
        .list_sync_blobs_page(
            &owner,
            &organization,
            (after.epoch, &after.id),
            limit,
            legacy,
        )
        .await
    else {
        return (StatusCode::CONFLICT, Json(json!({"error":"sync_page_unavailable", "required_format":"opensesame-sync-page-v2"}))).into_response();
    };
    let next = stored.last().map(|entry| Cursor {
        epoch: entry.sequence,
        id: entry.blob.id.clone(),
    });
    let blobs: Vec<_> = stored.into_iter()
        .filter(|entry| super::sync_blobs::project_scoped(&entry.blob.id, project.as_deref()))
        .map(|entry| if legacy {
            json!({"id":entry.blob.id,"epoch":entry.blob.epoch,"ingestion_epoch":entry.sequence,"ciphertext":entry.blob.ciphertext})
        } else {
            json!({"id":entry.blob.id,"epoch":entry.sequence,"ciphertext_epoch":entry.blob.epoch,"ciphertext_b64":STANDARD.encode(entry.blob.ciphertext)})
        }).collect();
    let mut response = json!({
        "format":"opensesame-sync-page", "version": if legacy { 1 } else { 2 },
        "blobs":blobs, "next_after":next, "has_more":has_more,
        "serialized_bytes":0, "plaintext":null,
        "deprecated":legacy,
    });
    // Fixpoint accounts for the decimal width of this field itself.
    loop {
        let size = match serde_json::to_vec(&response) {
            Ok(encoded) if encoded.len() <= 8 * 1024 * 1024 => encoded.len(),
            _ => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
        };
        if response["serialized_bytes"].as_u64() == Some(size as u64) {
            break;
        }
        response["serialized_bytes"] = json!(size);
    }
    if let (Some(device), Some(cursor)) = (body.device_id.as_deref(), next.as_ref()) {
        let cursor_owner = json!([organization, owner]).to_string();
        if st
            .db
            .advance_sync_cursor(&cursor_owner, device, cursor.epoch, 4096)
            .await
            .is_err()
        {
            return StatusCode::SERVICE_UNAVAILABLE.into_response();
        }
    }
    Json(response).into_response()
}
