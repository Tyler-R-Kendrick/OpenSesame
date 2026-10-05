//! HTTP face of a slot's file parts (ADR 0144, `vault_drive_parts.rs`).
//!
//!   GET /v1/vault-drive/slots/{slot}/parts          → { parts: [key, …] }
//!   GET /v1/vault-drive/slots/{slot}/parts/{part}   → the part's bytes | 404
//!   PUT /v1/vault-drive/slots/{slot}/parts/{part}   ← the part's bytes → 204
//!
//! Each takes the slot's access key as a bearer token, like the snapshot.
use crate::{
    vault_drive::parts::MAX_PART_BYTES,
    vault_drive_routes::{drive, error, refused, slot_key},
    App,
};
use axum::{
    body::Bytes,
    extract::{DefaultBodyLimit, Path, State},
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
    Json, Router,
};
use serde_json::json;
use std::sync::Arc;

async fn list_parts(
    State(st): State<App>,
    headers: HeaderMap,
    Path(slot): Path<String>,
) -> Response {
    let Some(key) = slot_key(&headers).map(str::to_string) else {
        return error(StatusCode::UNAUTHORIZED, "unauthorized");
    };
    let store = match drive(&st) {
        Ok(store) => Arc::clone(store),
        Err(resp) => return resp,
    };
    match tokio::task::spawn_blocking(move || store.list_parts(&slot, &key)).await {
        Ok(Ok(parts)) => Json(json!({ "parts": parts })).into_response(),
        Ok(Err(err)) => refused(err),
        Err(_) => error(StatusCode::INTERNAL_SERVER_ERROR, "storage_failed"),
    }
}

async fn read_part(
    State(st): State<App>,
    headers: HeaderMap,
    Path((slot, part)): Path<(String, String)>,
) -> Response {
    let Some(key) = slot_key(&headers).map(str::to_string) else {
        return error(StatusCode::UNAUTHORIZED, "unauthorized");
    };
    let store = match drive(&st) {
        Ok(store) => Arc::clone(store),
        Err(resp) => return resp,
    };
    match tokio::task::spawn_blocking(move || store.get_part(&slot, &key, &part)).await {
        Ok(Ok(Some(bytes))) => {
            ([(header::CONTENT_TYPE, "application/octet-stream")], bytes).into_response()
        }
        Ok(Ok(None)) => error(StatusCode::NOT_FOUND, "no_such_part"),
        Ok(Err(err)) => refused(err),
        Err(_) => error(StatusCode::INTERNAL_SERVER_ERROR, "storage_failed"),
    }
}

async fn write_part(
    State(st): State<App>,
    headers: HeaderMap,
    Path((slot, part)): Path<(String, String)>,
    body: Bytes,
) -> Response {
    let Some(key) = slot_key(&headers).map(str::to_string) else {
        return error(StatusCode::UNAUTHORIZED, "unauthorized");
    };
    let store = match drive(&st) {
        Ok(store) => Arc::clone(store),
        Err(resp) => return resp,
    };
    match tokio::task::spawn_blocking(move || store.put_part(&slot, &key, &part, &body)).await {
        Ok(Ok(())) => StatusCode::NO_CONTENT.into_response(),
        Ok(Err(err)) => refused(err),
        Err(_) => error(StatusCode::INTERNAL_SERVER_ERROR, "storage_failed"),
    }
}

pub(crate) fn routes() -> Router<App> {
    Router::new()
        .route("/v1/vault-drive/slots/{slot}/parts", get(list_parts))
        .route(
            "/v1/vault-drive/slots/{slot}/parts/{part}",
            get(read_part)
                .put(write_part)
                .layer(DefaultBodyLimit::max(MAX_PART_BYTES)),
        )
}
