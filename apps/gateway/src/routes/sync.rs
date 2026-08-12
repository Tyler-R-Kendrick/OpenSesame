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

/// Blobs the whole process will hold.
const MAX_SYNC_BLOBS: usize = 4096;
/// Blobs one session may own. The store is shared, so without a share per session
/// the first to fill it decides who else gets to sync.
const MAX_BLOBS_PER_SESSION: usize = 256;
/// Largest single sealed blob. Sync carries records, not files.
const MAX_BLOB_BYTES: usize = 256 * 1024;
/// Blobs one request may carry.
const MAX_BLOBS_PER_PUSH: usize = 128;
/// Devices one session may keep a cursor for.
const MAX_DEVICES_PER_SESSION: usize = 32;
/// A device id is a label, not a payload.
const MAX_DEVICE_ID_LEN: usize = 128;

/// Cursors are held per session as well as per device: two sessions naming the
/// same device must not share one, both because the cursor is a fact about one
/// session's blobs and because a session may only fill its own share of the map.
fn cursor_key(session_id: &str, device_id: &str) -> String {
    format!("{session_id}\u{1f}{device_id}")
}

/// Drop blobs whose owning session is gone. Their share of the store would
/// otherwise be held until the process restarted, and once the store is full
/// nobody can sync.
fn reclaim_dead_blobs(st: &AppState) -> usize {
    let live = crate::middleware::auth::live_session_ids(st);
    // Blobs then owners then cursors, the order every other holder uses. Taking
    // two of these in the opposite order to a concurrent push is all a deadlock
    // needs, and it would take the sync path down for everyone.
    let dead = {
        let Ok(mut store) = st.sync_blobs.lock() else {
            return 0;
        };
        let Ok(mut owners) = st.blob_owners.lock() else {
            return 0;
        };
        let dead = dead_blob_ids(&owners, &live);
        for id in &dead {
            owners.remove(id);
            store.remove(id);
        }
        dead
    };
    if let Ok(mut cursors) = st.device_cursors.lock() {
        cursors.retain(|key, _| cursor_is_live(key, &live));
    }
    dead.len()
}

/// Blobs owned by a session that is no longer live. Only ownership decides: a
/// blob whose owner is still around is not this function's to touch.
fn dead_blob_ids(
    owners: &std::collections::HashMap<String, String>,
    live: &std::collections::HashSet<String>,
) -> Vec<String> {
    owners
        .iter()
        .filter(|(_, owner)| !live.contains(*owner))
        .map(|(id, _)| id.clone())
        .collect()
}

/// Whether a cursor still belongs to a live session.
fn cursor_is_live(key: &str, live: &std::collections::HashSet<String>) -> bool {
    key.split('\u{1f}')
        .next()
        .is_some_and(|session| live.contains(session))
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
    if body.blobs.len() > MAX_BLOBS_PER_PUSH {
        return refused(
            "too_many_blobs",
            json!({"limit": MAX_BLOBS_PER_PUSH, "received": body.blobs.len()}),
        );
    }
    if let Some(oversized) = body
        .blobs
        .iter()
        .find(|blob| blob.ciphertext.len() > MAX_BLOB_BYTES)
    {
        return refused(
            "blob_too_large",
            json!({"limit_bytes": MAX_BLOB_BYTES, "blob_bytes": oversized.ciphertext.len()}),
        );
    }

    // Before deciding there is no room, give back what dead sessions are holding.
    let reclaimed = reclaim_dead_blobs(&st);

    let mut store = st.sync_blobs.lock().unwrap();
    let mut owners = st.blob_owners.lock().unwrap();
    let mut mine = owners.values().filter(|o| *o == &session_id).count();
    let mut accepted = 0u32;
    let mut rejected_foreign = 0u32;
    let mut over_quota = 0u32;
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
                // A foreign owner was turned away above, so an owner entry here is
                // this session's: the id is already counted against its share and
                // re-sending it costs nothing.
                let new_to_session = !owners.contains_key(&blob.id);
                let new_to_store = !store.contains_key(&blob.id);
                if !admits_blob(new_to_session, mine, new_to_store, store.len()) {
                    over_quota += 1;
                    continue;
                }
                if new_to_session {
                    mine += 1;
                }
                owners.insert(blob.id.clone(), session_id.clone());
                store.insert(blob.id.clone(), blob);
                accepted += 1;
            }
        }
    }
    let store_size = store.len();
    drop(owners);
    drop(store);

    // Dropping silently would let a client believe it had synced. Say what was
    // turned away, and refuse outright when nothing could be taken.
    if over_quota > 0 && accepted == 0 {
        return (
            StatusCode::INSUFFICIENT_STORAGE,
            Json(json!({
                "error": "sync_quota_exhausted",
                "detail": {
                    "per_session_limit": MAX_BLOBS_PER_SESSION,
                    "owned": mine,
                    "store_size": store_size,
                    "capacity": MAX_SYNC_BLOBS
                }
            })),
        )
            .into_response();
    }
    (
        StatusCode::OK,
        Json(json!({
            "accepted": accepted,
            "rejected_foreign_owner": rejected_foreign,
            "rejected_over_quota": over_quota,
            "reclaimed_from_dead_sessions": reclaimed,
            "owned": mine,
            "per_session_limit": MAX_BLOBS_PER_SESSION,
            "store_size": store_size,
            "capacity": MAX_SYNC_BLOBS
        })),
    )
        .into_response()
}

/// Whether this blob may be taken. A session is charged only for ids it does not
/// already own, and the shared store only for rows it does not already hold —
/// re-sending or updating what a session owns must never be refused for room.
/// The per-session share exists because one client filling the store would
/// otherwise decide who else gets to sync at all.
fn admits_blob(
    new_to_session: bool,
    owned_by_session: usize,
    new_to_store: bool,
    store_size: usize,
) -> bool {
    (!new_to_session || owned_by_session < MAX_BLOBS_PER_SESSION)
        && (!new_to_store || store_size < MAX_SYNC_BLOBS)
}

/// Too big to take: the request itself is out of bounds, not the store.
fn refused(error: &str, detail: serde_json::Value) -> Response {
    (
        StatusCode::PAYLOAD_TOO_LARGE,
        Json(json!({"error": error, "detail": detail})),
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
    if let Some(device_id) = body.device_id.as_ref() {
        if device_id.len() > MAX_DEVICE_ID_LEN {
            return refused(
                "device_id_too_long",
                json!({"limit": MAX_DEVICE_ID_LEN, "received": device_id.len()}),
            );
        }
    }
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
        let key = cursor_key(&session_id, device_id);
        let prefix = cursor_key(&session_id, "");
        let mine = cursors.keys().filter(|k| k.starts_with(&prefix)).count();
        // A cursor is a convenience, and a session naming endless devices must not
        // be able to grow shared memory. Beyond its share the epoch is still
        // reported, just not remembered.
        let entry = if cursors.contains_key(&key) || mine < MAX_DEVICES_PER_SESSION {
            let entry = cursors.entry(key).or_insert(0);
            if max_epoch > *entry {
                *entry = max_epoch;
            }
            *entry
        } else {
            max_epoch
        };
        device_cursor = Some(entry);
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
    use super::{
        admits_blob, cursor_is_live, cursor_key, dead_blob_ids, MAX_BLOBS_PER_SESSION,
        MAX_SYNC_BLOBS,
    };

    /// A session's share runs out while the store still has room for everyone
    /// else, so filling it is not one client's to do.
    #[test]
    fn one_session_cannot_take_the_whole_store() {
        assert!(admits_blob(true, 0, true, 0));
        assert!(admits_blob(true, MAX_BLOBS_PER_SESSION - 1, true, 0));
        assert!(!admits_blob(true, MAX_BLOBS_PER_SESSION, true, 0));
    }

    #[test]
    fn a_full_store_takes_nothing_more() {
        assert!(!admits_blob(true, 0, true, MAX_SYNC_BLOBS));
    }

    /// Its share is spent and the store is full, yet updating what it already owns
    /// adds nothing to either and must still go through.
    #[test]
    fn a_blob_already_owned_is_never_refused_for_room() {
        assert!(admits_blob(
            false,
            MAX_BLOBS_PER_SESSION,
            false,
            MAX_SYNC_BLOBS
        ));
        // Owned, but its row is gone: the store grows, so the store's cap applies
        // while the session's share does not.
        assert!(admits_blob(false, MAX_BLOBS_PER_SESSION, true, 0));
        assert!(!admits_blob(false, 0, true, MAX_SYNC_BLOBS));
    }

    /// What a session that is gone was holding comes back; what a live one holds
    /// stays, or syncing would lose records out from under a working client.
    #[test]
    fn only_a_dead_session_loses_its_blobs() {
        let owners = std::collections::HashMap::from([
            ("b1".to_string(), "live".to_string()),
            ("b2".to_string(), "gone".to_string()),
        ]);
        let live = std::collections::HashSet::from(["live".to_string()]);
        assert_eq!(dead_blob_ids(&owners, &live), vec!["b2".to_string()]);
        assert!(cursor_is_live(&cursor_key("live", "laptop"), &live));
        assert!(!cursor_is_live(&cursor_key("gone", "laptop"), &live));
    }

    /// A cursor names one session's view of a device. Two sessions on the same
    /// device must not read each other's, nor spend each other's share of the map.
    #[test]
    fn cursors_are_per_session() {
        assert_ne!(cursor_key("s1", "laptop"), cursor_key("s2", "laptop"));
        assert!(cursor_key("s1", "laptop").starts_with(&cursor_key("s1", "")));
        assert!(!cursor_key("s2", "laptop").starts_with(&cursor_key("s1", "")));
    }
}
