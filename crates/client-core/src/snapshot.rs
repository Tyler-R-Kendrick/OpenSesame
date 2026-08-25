//! Ciphertext sync snapshot helpers for offline encrypted cache / backup.
//!
//! # Threat model
//!
//! A snapshot file is **as sensitive as the vault**. It carries sealed AEAD
//! blobs only — never plaintext secrets and never a vault recovery key (VRK).
//! Anyone who obtains the file still needs the client-held unlock key to open
//! payloads. Protect snapshots at rest on disk like a password database.
//!
//! Host deployment seal keys (`OPENSESAME_CONNECTION_KEY` / broker sealing)
//! **must never** wrap these blobs. Wrapping is client `DeviceKey` / VRK only.

use serde::{Deserialize, Serialize};

use crate::{ClientCoreError, SyncBlob, SyncCursor, SyncStore};

/// Portable offline backup of opaque sync ciphertext.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct CiphertextSyncSnapshot {
    /// Stable format id — parsers reject anything else.
    pub format: String,
    pub version: u32,
    /// Optional Host Project scope (metadata only; Host never sees VRK).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_id: Option<String>,
    pub exported_at_unix_ms: u64,
    pub cursor: SyncCursor,
    /// Opaque `{ id, epoch, ciphertext }` only.
    pub blobs: Vec<SyncBlob>,
}

pub const SNAPSHOT_FORMAT: &str = "opensesame-ciphertext-sync-snapshot";
pub const SNAPSHOT_VERSION: u32 = 1;

impl CiphertextSyncSnapshot {
    #[must_use]
    pub fn new(
        cursor: SyncCursor,
        blobs: Vec<SyncBlob>,
        project_id: Option<String>,
        exported_at_unix_ms: u64,
    ) -> Self {
        Self {
            format: SNAPSHOT_FORMAT.to_string(),
            version: SNAPSHOT_VERSION,
            project_id,
            exported_at_unix_ms,
            cursor,
            blobs,
        }
    }

    /// Reject documents that are not opaque ciphertext snapshots.
    ///
    /// # Errors
    ///
    /// Returns an error when validation or the underlying operation fails.
    pub fn validate(&self) -> Result<(), ClientCoreError> {
        if self.format != SNAPSHOT_FORMAT {
            return Err(ClientCoreError::Persist(format!(
                "unknown snapshot format: {}",
                self.format
            )));
        }
        if self.version != SNAPSHOT_VERSION {
            return Err(ClientCoreError::Persist(format!(
                "unsupported snapshot version: {}",
                self.version
            )));
        }
        if self.cursor.device_id.is_empty() {
            return Err(ClientCoreError::Persist(
                "snapshot cursor missing device_id".into(),
            ));
        }
        for blob in &self.blobs {
            if blob.id.is_empty() {
                return Err(ClientCoreError::Persist("blob id empty".into()));
            }
            if blob.ciphertext.is_empty() {
                return Err(ClientCoreError::Persist(format!(
                    "blob {} has empty ciphertext",
                    blob.id
                )));
            }
        }
        Ok(())
    }

    ///
    /// # Errors
    ///
    /// Returns an error when validation or the underlying operation fails.
    pub fn to_json(&self) -> Result<String, ClientCoreError> {
        self.validate()?;
        let json =
            serde_json::to_string(self).map_err(|e| ClientCoreError::Persist(e.to_string()))?;
        assert_ciphertext_only_json(&json)?;
        Ok(json)
    }

    ///
    /// # Errors
    ///
    /// Returns an error when validation or the underlying operation fails.
    pub fn from_json(json: &str) -> Result<Self, ClientCoreError> {
        assert_ciphertext_only_json(json)?;
        let snap: Self =
            serde_json::from_str(json).map_err(|e| ClientCoreError::Persist(e.to_string()))?;
        snap.validate()?;
        Ok(snap)
    }
}

impl SyncStore {
    /// Export sealed blobs for offline use (ciphertext only; Host never sees VRK).
    pub fn export_ciphertext_snapshot(
        &self,
        project_id: Option<&str>,
        exported_at_unix_ms: u64,
    ) -> CiphertextSyncSnapshot {
        let blobs: Vec<SyncBlob> = self
            .entries
            .iter()
            .filter(|(id, _)| project_scoped(id, project_id))
            .map(|(id, (epoch, ct))| SyncBlob {
                id: id.clone(),
                epoch: *epoch,
                ciphertext: ct.clone(),
            })
            .collect();
        CiphertextSyncSnapshot::new(
            self.cursor.clone(),
            blobs,
            project_id.map(str::to_string),
            exported_at_unix_ms,
        )
    }

    /// Merge a ciphertext snapshot (last-writer-wins by epoch). Never decrypts.
    ///
    /// # Errors
    ///
    /// Returns an error when validation or the underlying operation fails.
    pub fn import_ciphertext_snapshot(
        &mut self,
        snapshot: &CiphertextSyncSnapshot,
    ) -> Result<usize, ClientCoreError> {
        snapshot.validate()?;
        let mut applied = 0usize;
        for blob in &snapshot.blobs {
            match self.entries.get(&blob.id) {
                Some((ep, _)) if *ep >= blob.epoch => {}
                _ => {
                    self.entries
                        .insert(blob.id.clone(), (blob.epoch, blob.ciphertext.clone()));
                    self.cursor.epoch = self.cursor.epoch.max(blob.epoch);
                    applied += 1;
                }
            }
        }
        Ok(applied)
    }

    /// All entries as opaque sync blobs (server / Host view).
    #[must_use]
    pub fn opaque_blobs(&self) -> Vec<SyncBlob> {
        self.entries
            .iter()
            .map(|(id, (epoch, ct))| SyncBlob {
                id: id.clone(),
                epoch: *epoch,
                ciphertext: ct.clone(),
            })
            .collect()
    }
}

/// When `project_id` is set, keep blobs whose id is exactly the project, or
/// uses `project:{id}:…` / `{id}/…` prefixes. `None` keeps every blob.
fn project_scoped(blob_id: &str, project_id: Option<&str>) -> bool {
    let Some(project_id) = project_id.filter(|p| !p.is_empty()) else {
        return true;
    };
    if blob_id == project_id {
        return true;
    }
    let prefixed = format!("project:{project_id}:");
    if blob_id.starts_with(&prefixed) {
        return true;
    }
    blob_id.starts_with(&format!("{project_id}/"))
}

/// Defense in depth: refuse JSON that smuggles plaintext fields or raw secret keys.
///
/// # Errors
///
/// Returns an error when validation or the underlying operation fails.
pub fn assert_ciphertext_only_json(json: &str) -> Result<(), ClientCoreError> {
    // Key-shaped needles only — avoid matching opaque ciphertext bytes/base64.
    for needle in [
        "\"plaintext\"",
        "\"secret\":",
        "\"password\":",
        "\"token\":",
        "\"vrk\"",
        "\"vault_key\"",
        "OPENSESAME_CONNECTION_KEY",
        "deployment_seal",
    ] {
        if json.contains(needle) {
            return Err(ClientCoreError::Persist(
                "refusing snapshot JSON with plaintext or deployment-seal fields".into(),
            ));
        }
    }
    Ok(())
}

/// Explicit guard: backup wrap material must not be a Host deployment seal key.
///
/// # Errors
///
/// Returns an error when validation or the underlying operation fails.
pub fn refuse_deployment_seal_as_wrap_key(candidate_label: &str) -> Result<(), ClientCoreError> {
    let lower = candidate_label.to_ascii_lowercase();
    if lower.contains("connection_key")
        || lower.contains("deployment_seal")
        || lower.contains("opensesame_connection")
        || lower.contains("broker_seal")
    {
        return Err(ClientCoreError::Persist(
            "deployment seal key must never wrap offline backups".into(),
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::DeviceKey;

    #[test]
    fn snapshot_roundtrip_ciphertext_only() {
        let key = DeviceKey::generate();
        let mut store = SyncStore::new("dev-snap");
        store
            .put_local(&key, "project:p1:note", b"offline-secret-xyz")
            .unwrap();
        store
            .put_local(&key, "project:p2:other", b"other-secret")
            .unwrap();

        let snap = store.export_ciphertext_snapshot(Some("p1"), 1_700_000_000_000);
        assert_eq!(snap.blobs.len(), 1);
        assert_eq!(snap.blobs[0].id, "project:p1:note");
        let json = snap.to_json().unwrap();
        assert!(!json.contains("offline-secret-xyz"));
        assert!(!json.contains("other-secret"));

        let parsed = CiphertextSyncSnapshot::from_json(&json).unwrap();
        let mut other = SyncStore::new("dev-b");
        let n = other.import_ciphertext_snapshot(&parsed).unwrap();
        assert!(n >= 1);
        assert!(other.entries.contains_key("project:p1:note"));
        let opened = crate::open(
            &key,
            &other.entries.get("project:p1:note").unwrap().1,
            b"project:p1:note",
        )
        .unwrap();
        assert_eq!(opened, b"offline-secret-xyz");
    }

    #[test]
    fn refuses_deployment_seal_wrap_label() {
        assert!(refuse_deployment_seal_as_wrap_key("device-vrk").is_ok());
        assert!(refuse_deployment_seal_as_wrap_key("OPENSESAME_CONNECTION_KEY").is_err());
        assert!(refuse_deployment_seal_as_wrap_key("deployment_seal").is_err());
    }

    #[test]
    fn from_json_rejects_plaintext_smuggling() {
        let bad = r#"{"format":"opensesame-ciphertext-sync-snapshot","version":1,"exported_at_unix_ms":1,"cursor":{"device_id":"d","epoch":0},"blobs":[],"plaintext":"leak"}"#;
        assert!(CiphertextSyncSnapshot::from_json(bad).is_err());
    }
}
