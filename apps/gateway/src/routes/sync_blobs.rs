//! Opaque ciphertext sync-blob routes.
//!
//! Host stores `{ id, epoch, ciphertext }` only. This module never decrypts,
//! never returns plaintext, and never uses the deployment / connection seal
//! key as a wrap key for client backups (ADR 0032 / WP-F).

use axum::{
    extract::State,
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use opensesame_client_core::SyncBlob;
use opensesame_storage::StoredSyncBlob;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::app_state::AppState;
use crate::middleware::auth::{require_session, session_subject};

/// Wire view of a stored sync blob — ciphertext only.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
pub struct OpaqueSyncBlobDto {
    pub id: String,
    pub epoch: u64,
    pub ciphertext: Vec<u8>,
}

impl From<StoredSyncBlob> for OpaqueSyncBlobDto {
    fn from(blob: StoredSyncBlob) -> Self {
        Self {
            id: blob.id,
            epoch: blob.epoch,
            ciphertext: blob.ciphertext,
        }
    }
}

impl From<SyncBlob> for OpaqueSyncBlobDto {
    fn from(blob: SyncBlob) -> Self {
        Self {
            id: blob.id,
            epoch: blob.epoch,
            ciphertext: blob.ciphertext,
        }
    }
}

impl From<OpaqueSyncBlobDto> for SyncBlob {
    fn from(blob: OpaqueSyncBlobDto) -> Self {
        Self {
            id: blob.id,
            epoch: blob.epoch,
            ciphertext: blob.ciphertext,
        }
    }
}

const FORBIDDEN_PLAINTEXT_KEYS: &[&str] = &[
    "plaintext",
    "secret",
    "password",
    "token",
    "vrk",
    "vault_key",
    "master_password",
    "connection_key",
    "deployment_seal",
];

/// Reject JSON objects that smuggle plaintext or deployment-seal fields.
pub fn assert_opaque_sync_json(value: &Value) -> Result<(), &'static str> {
    match value {
        Value::Object(map) => {
            for key in map.keys() {
                let lower = key.to_ascii_lowercase();
                if FORBIDDEN_PLAINTEXT_KEYS
                    .iter()
                    .any(|forbidden| lower == *forbidden || lower.contains(forbidden))
                {
                    return Err("plaintext_or_seal_field_forbidden");
                }
            }
            for child in map.values() {
                assert_opaque_sync_json(child)?;
            }
            Ok(())
        }
        Value::Array(items) => {
            for item in items {
                assert_opaque_sync_json(item)?;
            }
            Ok(())
        }
        _ => Ok(()),
    }
}

/// Validate a single blob is opaque ciphertext with non-empty payload.
pub fn validate_opaque_blob(blob: &OpaqueSyncBlobDto) -> Result<(), &'static str> {
    if blob.id.is_empty() {
        return Err("blob_id_empty");
    }
    if blob.ciphertext.is_empty() {
        return Err("ciphertext_empty");
    }
    Ok(())
}

#[derive(Deserialize)]
pub struct SyncBlobsSnapshotQuery {
    #[serde(default)]
    since_epoch: u64,
    #[serde(default)]
    project_id: Option<String>,
}

/// List the caller's sync blobs as opaque ciphertext (offline cache / backup source).
pub async fn snapshot(
    State(st): State<AppState>,
    headers: axum::http::HeaderMap,
    Json(body): Json<SyncBlobsSnapshotQuery>,
) -> Response {
    let owner_id = match require_session(&st, &headers) {
        Ok((_, meta)) => session_subject(&meta),
        Err(resp) => return resp,
    };
    let blobs: Vec<OpaqueSyncBlobDto> =
        match st.db.list_sync_blobs(&owner_id, body.since_epoch).await {
            Ok(rows) => rows
                .into_iter()
                .map(OpaqueSyncBlobDto::from)
                .filter(|blob| project_scoped(&blob.id, body.project_id.as_deref()))
                .collect(),
            Err(error) => {
                tracing::error!(error = %error, "encrypted sync snapshot failed");
                return (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(json!({"error": "sync_storage_failed"})),
                )
                    .into_response();
            }
        };
    Json(json!({
        "format": "opensesame-sync-blobs-snapshot",
        "version": 1,
        "project_id": body.project_id,
        "blobs": blobs,
        "plaintext": null,
        "note": "ciphertext only — Host never decrypts; VRK stays on device",
        "wrap_key": null,
        "deployment_seal_used": false,
    }))
    .into_response()
}

fn project_scoped(blob_id: &str, project_id: Option<&str>) -> bool {
    let Some(project_id) = project_id.filter(|p| !p.is_empty()) else {
        return true;
    };
    if blob_id == project_id {
        return true;
    }
    blob_id.starts_with(&format!("project:{project_id}:"))
        || blob_id.starts_with(&format!("{project_id}/"))
}

/// Push path that additionally rejects plaintext-smuggling JSON envelopes.
pub async fn push_opaque(
    State(st): State<AppState>,
    headers: axum::http::HeaderMap,
    Json(raw): Json<Value>,
) -> Response {
    if let Err(resp) = require_session(&st, &headers) {
        return resp;
    }
    if let Err(code) = assert_opaque_sync_json(&raw) {
        return (StatusCode::BAD_REQUEST, Json(json!({"error": code}))).into_response();
    }
    let Ok(body) = serde_json::from_value::<SyncPushOpaqueBody>(raw) else {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error": "invalid_sync_blobs"})),
        )
            .into_response();
    };
    for blob in &body.blobs {
        if let Err(code) = validate_opaque_blob(blob) {
            return (StatusCode::BAD_REQUEST, Json(json!({"error": code}))).into_response();
        }
    }
    // Reuse the existing durable push path by adapting DTOs → SyncBlob.
    super::sync::push(
        State(st),
        headers,
        Json(super::sync::SyncPushBody {
            blobs: body.blobs.into_iter().map(SyncBlob::from).collect(),
        }),
    )
    .await
}

#[derive(Deserialize)]
struct SyncPushOpaqueBody {
    blobs: Vec<OpaqueSyncBlobDto>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn rejects_plaintext_fields() {
        assert!(
            assert_opaque_sync_json(&json!({"blobs":[{"id":"a","epoch":1,"ciphertext":[1]}]}))
                .is_ok()
        );
        assert_eq!(
            assert_opaque_sync_json(&json!({"plaintext":"nope"})),
            Err("plaintext_or_seal_field_forbidden")
        );
        assert_eq!(
            assert_opaque_sync_json(&json!({"deployment_seal":"x"})),
            Err("plaintext_or_seal_field_forbidden")
        );
        assert_eq!(
            assert_opaque_sync_json(
                &json!({"blobs":[{"id":"a","epoch":1,"ciphertext":[1],"password":"x"}]})
            ),
            Err("plaintext_or_seal_field_forbidden")
        );
    }

    #[test]
    fn validate_requires_ciphertext() {
        assert!(validate_opaque_blob(&OpaqueSyncBlobDto {
            id: "a".into(),
            epoch: 1,
            ciphertext: vec![9],
        })
        .is_ok());
        assert_eq!(
            validate_opaque_blob(&OpaqueSyncBlobDto {
                id: "a".into(),
                epoch: 1,
                ciphertext: vec![],
            }),
            Err("ciphertext_empty")
        );
    }

    #[test]
    fn project_scope_filters() {
        assert!(project_scoped("project:p1:x", Some("p1")));
        assert!(!project_scoped("project:p2:x", Some("p1")));
        assert!(project_scoped("anything", None));
    }

    #[tokio::test]
    async fn snapshot_without_session_fails_closed() {
        let state = crate::app_state::test_demo_state().await;
        let response = snapshot(
            State(state),
            axum::http::HeaderMap::new(),
            Json(SyncBlobsSnapshotQuery {
                since_epoch: 0,
                project_id: None,
            }),
        )
        .await;
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn push_without_session_fails_closed() {
        let state = crate::app_state::test_demo_state().await;
        let response = push_opaque(
            State(state),
            axum::http::HeaderMap::new(),
            Json(json!({"blobs":[{"id":"a","epoch":1,"ciphertext":[1]}]})),
        )
        .await;
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    }
}
