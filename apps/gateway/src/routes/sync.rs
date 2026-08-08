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

/// Global blob ceiling (shared store).
const MAX_SYNC_BLOBS: usize = 4096;
/// Per-session blob ceiling so one session cannot evict/starve every tenant.
const MAX_BLOBS_PER_SESSION: usize = 512;
/// Per-blob ciphertext ceiling — sync carries sealed records, not file payloads.
const MAX_CIPHERTEXT_BYTES: usize = 256 * 1024;
/// Cursor table ceiling and device id length cap (client-supplied keys).
const MAX_DEVICE_CURSORS: usize = 4096;
const MAX_DEVICE_ID_LEN: usize = 128;

/// Why a pushed blob was not stored (each maps to a response counter).
#[derive(Debug, PartialEq, Eq)]
enum PushOutcome {
    Accept,
    Oversize,
    ForeignOwner,
    SessionQuota,
    StoreFull,
    StaleEpoch,
}

/// Admission decision for one blob — pure so quotas are testable without a live store.
fn push_outcome(
    ciphertext_len: usize,
    current_owner: Option<&str>,
    session_id: &str,
    existing_epoch: Option<u64>,
    incoming_epoch: u64,
    store_len: usize,
    session_owned: usize,
) -> PushOutcome {
    if ciphertext_len > MAX_CIPHERTEXT_BYTES {
        return PushOutcome::Oversize;
    }
    if let Some(owner) = current_owner {
        if owner != session_id {
            return PushOutcome::ForeignOwner;
        }
    }
    match existing_epoch {
        Some(epoch) if epoch > incoming_epoch => PushOutcome::StaleEpoch,
        Some(_) => PushOutcome::Accept,
        None if store_len >= MAX_SYNC_BLOBS => PushOutcome::StoreFull,
        None if session_owned >= MAX_BLOBS_PER_SESSION => PushOutcome::SessionQuota,
        None => PushOutcome::Accept,
    }
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
    let mut rejected_oversize = 0u32;
    let mut rejected_quota = 0u32;
    let mut owned = owners.values().filter(|o| *o == &session_id).count();
    for blob in body.blobs {
        let existing_epoch = store.get(&blob.id).map(|b| b.epoch);
        let outcome = push_outcome(
            blob.ciphertext.len(),
            owners.get(&blob.id).map(String::as_str),
            &session_id,
            existing_epoch,
            blob.epoch,
            store.len(),
            owned,
        );
        match outcome {
            PushOutcome::Oversize => rejected_oversize += 1,
            PushOutcome::ForeignOwner => rejected_foreign += 1,
            PushOutcome::SessionQuota => rejected_quota += 1,
            PushOutcome::StoreFull | PushOutcome::StaleEpoch => {}
            PushOutcome::Accept => {
                if existing_epoch.is_none() {
                    owned += 1;
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
            "rejected_oversize": rejected_oversize,
            "rejected_session_quota": rejected_quota,
            "store_size": store.len(),
            "capacity": MAX_SYNC_BLOBS,
            "session_capacity": MAX_BLOBS_PER_SESSION,
            "max_ciphertext_bytes": MAX_CIPHERTEXT_BYTES
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
    if let Some(device_id) = body
        .device_id
        .as_ref()
        .filter(|s| !s.is_empty() && s.len() <= MAX_DEVICE_ID_LEN)
    {
        let mut cursors = st.device_cursors.lock().unwrap();
        let max_epoch = blobs.iter().map(|b| b.epoch).max().unwrap_or(since);
        // Client-supplied keys: only track new devices while under the ceiling.
        if cursors.contains_key(device_id) || cursors.len() < MAX_DEVICE_CURSORS {
            let entry = cursors.entry(device_id.clone()).or_insert(0);
            if max_epoch > *entry {
                *entry = max_epoch;
            }
            device_cursor = Some(*entry);
        }
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

#[cfg(test)]
mod tests {
    use super::*;

    fn outcome(
        len: usize,
        owner: Option<&str>,
        existing: Option<u64>,
        owned: usize,
    ) -> PushOutcome {
        push_outcome(len, owner, "sess_a", existing, 7, 0, owned)
    }

    #[test]
    fn oversize_ciphertext_is_rejected() {
        assert_eq!(
            outcome(MAX_CIPHERTEXT_BYTES + 1, None, None, 0),
            PushOutcome::Oversize
        );
        assert_eq!(
            outcome(MAX_CIPHERTEXT_BYTES, None, None, 0),
            PushOutcome::Accept
        );
    }

    #[test]
    fn foreign_owner_cannot_overwrite() {
        assert_eq!(
            outcome(16, Some("sess_b"), Some(1), 0),
            PushOutcome::ForeignOwner
        );
        assert_eq!(outcome(16, Some("sess_a"), Some(1), 0), PushOutcome::Accept);
    }

    #[test]
    fn session_quota_stops_new_blobs_but_allows_updates() {
        assert_eq!(
            outcome(16, None, None, MAX_BLOBS_PER_SESSION),
            PushOutcome::SessionQuota
        );
        // Updating an already-owned blob is still allowed at quota.
        assert_eq!(
            outcome(16, Some("sess_a"), Some(1), MAX_BLOBS_PER_SESSION),
            PushOutcome::Accept
        );
    }

    #[test]
    fn one_session_cannot_fill_the_shared_store() {
        assert_eq!(
            push_outcome(16, None, "sess_a", None, 1, MAX_SYNC_BLOBS, 0),
            PushOutcome::StoreFull
        );
        assert!(MAX_BLOBS_PER_SESSION.saturating_mul(2) <= MAX_SYNC_BLOBS);
    }

    #[test]
    fn stale_epochs_do_not_overwrite() {
        assert_eq!(
            outcome(16, Some("sess_a"), Some(9), 0),
            PushOutcome::StaleEpoch
        );
    }
}
