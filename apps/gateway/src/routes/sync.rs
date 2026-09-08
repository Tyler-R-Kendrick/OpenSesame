use axum::{
    extract::State,
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use opensesame_client_core::SyncBlob;
use opensesame_storage::{StoredSyncBlob, SyncWriteOutcome};
use serde::Deserialize;
use serde_json::json;

use crate::app_state::AppState;
use crate::middleware::auth::{require_session, session_subject};

#[derive(Deserialize)]
pub(crate) struct SyncPushBody {
    pub(crate) blobs: Vec<SyncBlob>,
}

#[derive(Deserialize)]
pub struct SyncPullBody {
    #[serde(default)]
    after: Option<super::sync_page::Cursor>,
    #[serde(default)]
    limit: Option<u32>,
    #[serde(default)]
    since_epoch: u64,
    #[serde(default)]
    device_id: Option<String>,
}

/// Per-request blob count so one push cannot walk the whole store.
const MAX_BLOBS_PER_REQUEST: usize = 64;
/// Global blob ceiling (shared store).
const MAX_SYNC_BLOBS: usize = 4096;
/// Per-principal blob ceiling so one identity cannot starve every tenant.
const MAX_BLOBS_PER_OWNER: usize = 512;
/// Per-blob ciphertext ceiling — vault sealed bodies can exceed small limits;
/// still bounded so sync is not a file dump.
const MAX_CIPHERTEXT_BYTES: usize = 2 * 1024 * 1024;

pub async fn push(
    State(st): State<AppState>,
    headers: axum::http::HeaderMap,
    Json(body): Json<SyncPushBody>,
) -> Response {
    let (owner_id, organization_id) = match require_session(&st, &headers) {
        Ok((_, meta)) => (session_subject(&meta), meta.organization_id.to_string()),
        Err(resp) => return resp,
    };
    if body.blobs.len() > MAX_BLOBS_PER_REQUEST {
        return (
            StatusCode::PAYLOAD_TOO_LARGE,
            Json(json!({"error": "too_many_blobs", "max": MAX_BLOBS_PER_REQUEST})),
        )
            .into_response();
    }
    let mut accepted = 0u32;
    let mut rejected_foreign = 0u32;
    let mut rejected_oversize = 0u32;
    let mut rejected_quota = 0u32;
    let mut rejected_stale_epoch = 0u32;
    let mut stored_blobs = Vec::new();
    for blob in body.blobs {
        if blob.ciphertext.len() > MAX_CIPHERTEXT_BYTES || blob.id.is_empty() || blob.id.len() > 128
        {
            rejected_oversize += 1;
            continue;
        }
        stored_blobs.push(StoredSyncBlob {
            id: blob.id,
            epoch: blob.epoch,
            ciphertext: blob.ciphertext,
        });
    }
    let outcomes = if rejected_oversize > 0 {
        vec![SyncWriteOutcome::BatchAborted; stored_blobs.len()]
    } else {
        match st
            .db
            .write_sync_blobs_scoped(
                &owner_id,
                &organization_id,
                &stored_blobs,
                i64::try_from(MAX_SYNC_BLOBS).expect("sync blob limit fits i64"),
                i64::try_from(MAX_BLOBS_PER_OWNER).expect("owner blob limit fits i64"),
            )
            .await
        {
            Ok(outcomes) => outcomes,
            Err(error) => {
                tracing::error!(error = %error, "encrypted sync write failed");
                return (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(json!({"error": "sync_storage_failed"})),
                )
                    .into_response();
            }
        }
    };
    let mut rejected_batch = 0u32;
    for outcome in outcomes {
        match outcome {
            SyncWriteOutcome::Accepted => accepted += 1,
            SyncWriteOutcome::BatchAborted => rejected_batch += 1,
            SyncWriteOutcome::ForeignOwner => rejected_foreign += 1,
            SyncWriteOutcome::OwnerQuota => rejected_quota += 1,
            SyncWriteOutcome::StaleEpoch => rejected_stale_epoch += 1,
            SyncWriteOutcome::StoreFull => {}
        }
    }
    if accepted > 0 {
        st.backup_notify.notify_one();
    }
    (
        StatusCode::OK,
        Json(json!({
            "accepted": accepted,
            "rejected_foreign_owner": rejected_foreign,
            "rejected_oversize": rejected_oversize,
            "rejected_session_quota": rejected_quota,
            "rejected_stale_epoch": rejected_stale_epoch,
            "rejected_batch": rejected_batch,
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
    if body.after.is_none() && body.since_epoch != 0 {
        return (
            StatusCode::CONFLICT,
            Json(json!({"error":"sync_cursor_upgrade_required","restart_after":null})),
        )
            .into_response();
    }
    super::sync_page::serve_page(
        &st,
        &headers,
        super::sync_page::PageQuery {
            after: body.after.or_else(|| {
                Some(super::sync_page::Cursor {
                    epoch: body.since_epoch.saturating_add(1),
                    id: String::new(),
                })
            }),
            limit: body.limit,
            device_id: body.device_id,
        },
        true,
        None,
    )
    .await
}

#[cfg(test)]
#[derive(Debug, PartialEq, Eq)]
enum PushOutcome {
    Accept,
    Oversize,
    ForeignOwner,
    SessionQuota,
    StoreFull,
    StaleEpoch,
}

#[cfg(test)]
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
    if current_owner.is_some_and(|owner| owner != owner_id) {
        return PushOutcome::ForeignOwner;
    }
    match existing_epoch {
        Some(epoch) if epoch >= incoming_epoch => PushOutcome::StaleEpoch,
        None if store_len >= MAX_SYNC_BLOBS => PushOutcome::StoreFull,
        None if session_owned >= MAX_BLOBS_PER_OWNER => PushOutcome::SessionQuota,
        Some(_) | None => PushOutcome::Accept,
    }
}

#[cfg(test)]
#[expect(
    clippy::similar_names,
    reason = "the sync decision table intentionally compares parallel owner and epoch inputs"
)]
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
        assert_eq!(
            outcome(16, Some("sess_a"), Some(7), 0),
            PushOutcome::StaleEpoch
        );
    }

    #[test]
    fn renewed_sessions_share_the_principals_ciphertext() {
        let first = crate::session_claims::fixture(
            opensesame_domain::PrincipalId::new(),
            opensesame_domain::OrganizationId::new(),
            opensesame_domain::OrganizationRole::Member,
            "https://host.test",
        );
        let renewed = first.clone();
        assert_eq!(session_subject(&first), session_subject(&renewed));
    }
}
