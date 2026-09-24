//! HTTP face of the tailnet vault drive (ADR 0140).
//!
//! Operator routes (open, list, close a slot) take the operator token or the
//! Unix-socket peer check like every other mutating daemon route, and refuse
//! a browser. Device routes (read and replace a slot's snapshot) take only the
//! slot's access key as a bearer token; they are what a paired phone or laptop
//! reaches through Tailscale Serve, and what the whois-gated tailnet listener
//! serves to native devices.
use crate::{
    require_operator,
    vault_drive::{self, DriveError, DriveStore},
    App, UdsPeer,
};
use axum::{
    extract::{DefaultBodyLimit, Path, State},
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{delete, get},
    Json, Router,
};
use base64::Engine as _;
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Arc;

pub const PAIRING_PREFIX: &str = "opensesame-drive:v1:";

/// JSON framing around the largest snapshot a slot accepts.
const MAX_PUT_BYTES: usize = vault_drive::MAX_SNAPSHOT_BYTES + 64 * 1024;

fn error(status: StatusCode, code: &str) -> Response {
    (status, Json(json!({ "error": code }))).into_response()
}

fn drive(st: &App) -> Result<&Arc<DriveStore>, Response> {
    st.vault_drive
        .as_ref()
        .ok_or_else(|| error(StatusCode::SERVICE_UNAVAILABLE, "vault_drive_unconfigured"))
}

fn refused(err: DriveError) -> Response {
    match err {
        DriveError::Unauthorized => error(StatusCode::UNAUTHORIZED, "unauthorized"),
        DriveError::Conflict(generation) => (
            StatusCode::CONFLICT,
            Json(json!({ "error": "generation_mismatch", "generation": generation })),
        )
            .into_response(),
        DriveError::TooLarge => error(StatusCode::PAYLOAD_TOO_LARGE, "snapshot_too_large"),
        DriveError::Full => error(StatusCode::INSUFFICIENT_STORAGE, "too_many_slots"),
        DriveError::Invalid(code) => error(StatusCode::BAD_REQUEST, code),
        DriveError::Io(io) => {
            tracing::warn!(error = %io, "vault drive storage failed");
            error(StatusCode::INTERNAL_SERVER_ERROR, "storage_failed")
        }
    }
}

/// The slot key from `Authorization: Bearer <key>`; operator tokens never qualify.
fn slot_key(headers: &HeaderMap) -> Option<&str> {
    let value = headers.get(header::AUTHORIZATION)?.to_str().ok()?;
    let key = value.strip_prefix("Bearer ")?.trim();
    let shaped = (32..=128).contains(&key.len())
        && key
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_');
    shaped.then_some(key)
}

#[derive(Deserialize)]
struct CreateSlot {
    #[serde(default)]
    label: String,
    /// Where devices reach this daemon; defaults to its Tailscale Serve URL.
    #[serde(default)]
    url: Option<String>,
}

fn pairing_code(url: &str, slot: &str, key: &str, label: &str) -> String {
    let json = json!({ "url": url, "slot": slot, "key": key, "label": label });
    format!(
        "{PAIRING_PREFIX}{}",
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(json.to_string())
    )
}

fn serve_url() -> Option<String> {
    crate::tailscale::info()
        .https_url
        .map(|url| url.trim_end_matches('/').to_string())
        .filter(|url| !url.is_empty())
}

async fn create_slot(
    State(st): State<App>,
    uds: UdsPeer,
    headers: HeaderMap,
    Json(body): Json<CreateSlot>,
) -> Response {
    if let Err(resp) = require_operator(&st, &headers, &uds) {
        return resp;
    }
    let store = match drive(&st) {
        Ok(store) => Arc::clone(store),
        Err(resp) => return resp,
    };
    let explicit = body.url.map(|u| u.trim().trim_end_matches('/').to_string());
    let url = match explicit.filter(|u| !u.is_empty()) {
        Some(url) => Some(url),
        None => tokio::task::spawn_blocking(serve_url).await.ok().flatten(),
    };
    let Some(url) = url else {
        return error(StatusCode::BAD_REQUEST, "no_tailnet_url");
    };
    let label = body.label;
    match tokio::task::spawn_blocking(move || store.create(&label)).await {
        Ok(Ok((view, key))) => {
            let code = pairing_code(&url, &view.slot, &key, &view.label);
            (
                StatusCode::CREATED,
                Json(json!({ "slot": view, "url": url, "pairing_code": code })),
            )
                .into_response()
        }
        Ok(Err(err)) => refused(err),
        Err(_) => error(StatusCode::INTERNAL_SERVER_ERROR, "storage_failed"),
    }
}

async fn list_slots(State(st): State<App>, uds: UdsPeer, headers: HeaderMap) -> Response {
    if let Err(resp) = require_operator(&st, &headers, &uds) {
        return resp;
    }
    let store = match drive(&st) {
        Ok(store) => Arc::clone(store),
        Err(resp) => return resp,
    };
    match tokio::task::spawn_blocking(move || store.list()).await {
        Ok(Ok(slots)) => Json(json!({ "slots": slots })).into_response(),
        _ => error(StatusCode::INTERNAL_SERVER_ERROR, "storage_failed"),
    }
}

async fn remove_slot(
    State(st): State<App>,
    uds: UdsPeer,
    headers: HeaderMap,
    Path(slot): Path<String>,
) -> Response {
    if let Err(resp) = require_operator(&st, &headers, &uds) {
        return resp;
    }
    let store = match drive(&st) {
        Ok(store) => Arc::clone(store),
        Err(resp) => return resp,
    };
    match tokio::task::spawn_blocking(move || store.remove(&slot)).await {
        Ok(Ok(true)) => StatusCode::NO_CONTENT.into_response(),
        Ok(Ok(false)) => error(StatusCode::NOT_FOUND, "no_such_slot"),
        _ => error(StatusCode::INTERNAL_SERVER_ERROR, "storage_failed"),
    }
}

pub(crate) async fn read_snapshot(
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
    match tokio::task::spawn_blocking(move || store.read(&slot, &key)).await {
        Ok(Ok((generation, None))) => {
            Json(json!({ "generation": generation, "snapshot": null })).into_response()
        }
        Ok(Ok((generation, Some(bytes)))) => match serde_json::from_slice::<Value>(&bytes) {
            Ok(snapshot) => {
                Json(json!({ "generation": generation, "snapshot": snapshot })).into_response()
            }
            Err(_) => error(StatusCode::INTERNAL_SERVER_ERROR, "storage_failed"),
        },
        Ok(Err(err)) => refused(err),
        Err(_) => error(StatusCode::INTERNAL_SERVER_ERROR, "storage_failed"),
    }
}

#[derive(Deserialize)]
pub(crate) struct PutSnapshot {
    expected_generation: u64,
    snapshot: Value,
}

pub(crate) async fn write_snapshot(
    State(st): State<App>,
    headers: HeaderMap,
    Path(slot): Path<String>,
    Json(body): Json<PutSnapshot>,
) -> Response {
    let Some(key) = slot_key(&headers).map(str::to_string) else {
        return error(StatusCode::UNAUTHORIZED, "unauthorized");
    };
    let store = match drive(&st) {
        Ok(store) => Arc::clone(store),
        Err(resp) => return resp,
    };
    // Blind beyond this: the drive checks a snapshot says what it is, and no more.
    if body.snapshot.get("format").and_then(Value::as_str) != Some(vault_drive::SNAPSHOT_FORMAT) {
        return refused(DriveError::Invalid("not_a_vault_snapshot"));
    }
    let Ok(bytes) = serde_json::to_vec(&body.snapshot) else {
        return refused(DriveError::Invalid("not_a_vault_snapshot"));
    };
    let expected = body.expected_generation;
    match tokio::task::spawn_blocking(move || store.write(&slot, &key, expected, &bytes)).await {
        Ok(Ok(generation)) => Json(json!({ "generation": generation })).into_response(),
        Ok(Err(err)) => refused(err),
        Err(_) => error(StatusCode::INTERNAL_SERVER_ERROR, "storage_failed"),
    }
}

/// Device routes only — what the whois-gated tailnet listener also serves.
pub(crate) fn device_routes() -> Router<App> {
    Router::new().route(
        "/v1/vault-drive/slots/{slot}/snapshot",
        get(read_snapshot)
            .put(write_snapshot)
            .layer(DefaultBodyLimit::max(MAX_PUT_BYTES)),
    )
}

/// Every drive route, for the main listener.
pub(crate) fn routes() -> Router<App> {
    device_routes()
        .route(
            "/v1/vault-drive/slots",
            get(list_slots)
                .post(create_slot)
                .layer(DefaultBodyLimit::max(4096)),
        )
        .route("/v1/vault-drive/slots/{slot}", delete(remove_slot))
}

#[cfg(test)]
#[path = "vault_drive_routes_tests.rs"]
mod tests;
