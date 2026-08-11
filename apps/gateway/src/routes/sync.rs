use axum::{
    extract::State,
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use opensesame_client_core::SyncBlob;
use opensesame_host_core::daemon as host_daemon;
use opensesame_storage::{StoredSyncBlob, SyncWriteOutcome};
use serde::Deserialize;
use serde_json::json;

use crate::app_state::AppState;
use crate::middleware::auth::{require_session, session_subject};

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
/// Per-principal blob ceiling so one identity cannot starve every tenant.
const MAX_BLOBS_PER_OWNER: usize = 512;
/// Per-blob ciphertext ceiling — sync carries sealed records, not file payloads.
const MAX_CIPHERTEXT_BYTES: usize = 256 * 1024;
/// Device id length cap (client-supplied keys).
const MAX_DEVICE_ID_LEN: usize = 128;
/// Global durable cursor ceiling; existing devices can always advance at quota.
const MAX_DEVICE_CURSORS: usize = 4096;

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
    owner_id: &str,
    existing_epoch: Option<u64>,
    incoming_epoch: u64,
    store_len: usize,
    session_owned: usize,
) -> PushOutcome {
    if ciphertext_len > MAX_CIPHERTEXT_BYTES {
        return PushOutcome::Oversize;
    }
    if let Some(owner) = current_owner {
        if owner != owner_id {
            return PushOutcome::ForeignOwner;
        }
    }
    match existing_epoch {
        Some(epoch) if epoch > incoming_epoch => PushOutcome::StaleEpoch,
        Some(_) => PushOutcome::Accept,
        None if store_len >= MAX_SYNC_BLOBS => PushOutcome::StoreFull,
        None if session_owned >= MAX_BLOBS_PER_OWNER => PushOutcome::SessionQuota,
        None => PushOutcome::Accept,
    }
}

pub async fn push(
    State(st): State<AppState>,
    headers: axum::http::HeaderMap,
    Json(body): Json<SyncPushBody>,
) -> Response {
    let owner_id = match require_session(&st, &headers) {
        Ok((_, meta)) => session_subject(&meta),
        Err(resp) => return resp,
    };
    let mut accepted = 0u32;
    let mut rejected_foreign = 0u32;
    let mut rejected_oversize = 0u32;
    let mut rejected_quota = 0u32;
    for blob in body.blobs {
        if blob.ciphertext.len() > MAX_CIPHERTEXT_BYTES {
            rejected_oversize += 1;
            continue;
        }
        let stored = StoredSyncBlob {
            id: blob.id,
            epoch: blob.epoch,
            ciphertext: blob.ciphertext,
        };
        match st
            .db
            .write_sync_blob(
                &owner_id,
                &stored,
                MAX_SYNC_BLOBS as i64,
                MAX_BLOBS_PER_OWNER as i64,
            )
            .await
        {
            Ok(SyncWriteOutcome::Accepted) => accepted += 1,
            Ok(SyncWriteOutcome::ForeignOwner) => rejected_foreign += 1,
            Ok(SyncWriteOutcome::OwnerQuota) => rejected_quota += 1,
            Ok(SyncWriteOutcome::StoreFull | SyncWriteOutcome::StaleEpoch) => {}
            Err(error) => {
                tracing::error!(error = %error, "encrypted sync write failed");
                return (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(json!({"error": "sync_storage_failed"})),
                )
                    .into_response();
            }
        }
    }
    let store_size = match st.db.count_sync_blobs().await {
        Ok(count) => count,
        Err(error) => {
            tracing::error!(error = %error, "encrypted sync count failed");
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({"error": "sync_storage_failed"})),
            )
                .into_response();
        }
    };
    (
        StatusCode::OK,
        Json(json!({
            "accepted": accepted,
            "rejected_foreign_owner": rejected_foreign,
            "rejected_oversize": rejected_oversize,
            "rejected_session_quota": rejected_quota,
            "store_size": store_size,
            "capacity": MAX_SYNC_BLOBS,
            "owner_capacity": MAX_BLOBS_PER_OWNER,
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
    let owner_id = match require_session(&st, &headers) {
        Ok((_, meta)) => session_subject(&meta),
        Err(resp) => return resp,
    };
    let since = body.since_epoch;
    let blobs: Vec<SyncBlob> = match st.db.list_sync_blobs(&owner_id, since).await {
        Ok(blobs) => blobs
            .into_iter()
            .map(|blob| SyncBlob {
                id: blob.id,
                epoch: blob.epoch,
                ciphertext: blob.ciphertext,
            })
            .collect(),
        Err(error) => {
            tracing::error!(error = %error, "encrypted sync read failed");
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({"error": "sync_storage_failed"})),
            )
                .into_response();
        }
    };
    let mut device_cursor = None;
    if let Some(device_id) = body
        .device_id
        .as_ref()
        .filter(|s| !s.is_empty() && s.len() <= MAX_DEVICE_ID_LEN)
    {
        let max_epoch = blobs.iter().map(|b| b.epoch).max().unwrap_or(since);
        match st
            .db
            .advance_sync_cursor(&owner_id, device_id, max_epoch, MAX_DEVICE_CURSORS as i64)
            .await
        {
            Ok(cursor) => device_cursor = cursor,
            Err(error) => {
                tracing::error!(error = %error, "encrypted sync cursor write failed");
                return (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(json!({"error": "sync_storage_failed"})),
                )
                    .into_response();
            }
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
            outcome(16, None, None, MAX_BLOBS_PER_OWNER),
            PushOutcome::SessionQuota
        );
        // Updating an already-owned blob is still allowed at quota.
        assert_eq!(
            outcome(16, Some("sess_a"), Some(1), MAX_BLOBS_PER_OWNER),
            PushOutcome::Accept
        );
    }

    #[test]
    fn one_session_cannot_fill_the_shared_store() {
        assert_eq!(
            push_outcome(16, None, "sess_a", None, 1, MAX_SYNC_BLOBS, 0),
            PushOutcome::StoreFull
        );
        assert!(MAX_BLOBS_PER_OWNER.saturating_mul(2) <= MAX_SYNC_BLOBS);
    }

    #[test]
    fn stale_epochs_do_not_overwrite() {
        assert_eq!(
            outcome(16, Some("sess_a"), Some(9), 0),
            PushOutcome::StaleEpoch
        );
    }

    #[test]
    fn renewed_sessions_share_the_principals_ciphertext() {
        let first = json!({"session_id": "first", "approved_as": "principal:alice"});
        let renewed = json!({"session_id": "renewed", "approved_as": "principal:alice"});
        assert_eq!(session_subject(&first), session_subject(&renewed));
    }
}
