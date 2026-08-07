use axum::{
    extract::State,
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use opensesame_client_core::SyncBlob;
use opensesame_host_core::daemon as host_daemon;
use serde::Deserialize;
use serde_json::json;

use crate::app_state::AppState;
use crate::middleware::auth::require_session;

#[derive(Deserialize)]
pub struct SyncPushBody {
    blobs: Vec<SyncBlob>,
}

#[derive(Deserialize)]
pub struct SyncPullBody {
    #[serde(default)]
    since_epoch: u64,
    #[serde(default)]
    device_id: Option<String>,
}

pub async fn push(
    State(st): State<AppState>,
    headers: axum::http::HeaderMap,
    Json(body): Json<SyncPushBody>,
) -> Response {
    let session_id = match require_session(&st, &headers) {
        Ok((id, _)) => id,
        Err(resp) => return resp,
    };
    let mut store = st.sync_blobs.lock().unwrap();
    let mut owners = st.blob_owners.lock().unwrap();
    let mut accepted = 0u32;
    let mut rejected_foreign = 0u32;
    const MAX_SYNC_BLOBS: usize = 4096;
    for blob in body.blobs {
        if let Some(owner) = owners.get(&blob.id) {
            if owner != &session_id {
                rejected_foreign += 1;
                continue;
            }
        }
        match store.get(&blob.id) {
            Some(existing) if existing.epoch > blob.epoch => {}
            _ => {
                let is_new = !store.contains_key(&blob.id);
                if is_new && store.len() >= MAX_SYNC_BLOBS {
                    continue;
                }
                owners.insert(blob.id.clone(), session_id.clone());
                store.insert(blob.id.clone(), blob);
                accepted += 1;
            }
        }
    }
    (
        StatusCode::OK,
        Json(json!({
            "accepted": accepted,
            "rejected_foreign_owner": rejected_foreign,
            "store_size": store.len(),
            "capacity": MAX_SYNC_BLOBS
        })),
    )
        .into_response()
}

pub async fn pull(
    State(st): State<AppState>,
    headers: axum::http::HeaderMap,
    Json(body): Json<SyncPullBody>,
) -> Response {
    let session_id = match require_session(&st, &headers) {
        Ok((id, _)) => id,
        Err(resp) => return resp,
    };
    let since = body.since_epoch;
    let store = st.sync_blobs.lock().unwrap();
    let owners = st.blob_owners.lock().unwrap();
    let blobs: Vec<SyncBlob> = store
        .values()
        .filter(|b| b.epoch > since)
        .filter(|b| owners.get(&b.id).map(|o| o == &session_id).unwrap_or(false))
        .cloned()
        .collect();
    drop(owners);
    drop(store);
    let mut device_cursor = None;
    if let Some(device_id) = body.device_id.as_ref().filter(|s| !s.is_empty()) {
        let mut cursors = st.device_cursors.lock().unwrap();
        let max_epoch = blobs.iter().map(|b| b.epoch).max().unwrap_or(since);
        let entry = cursors.entry(device_id.clone()).or_insert(0);
        if max_epoch > *entry {
            *entry = max_epoch;
        }
        device_cursor = Some(*entry);
    }
    let _ = host_daemon::DEFAULT_LISTEN;
    Json(json!({
        "blobs": blobs,
        "plaintext": null,
        "note": "ciphertext only",
        "device_cursor": device_cursor,
        "daemon_default_listen": host_daemon::DEFAULT_LISTEN,
    }))
    .into_response()
}
