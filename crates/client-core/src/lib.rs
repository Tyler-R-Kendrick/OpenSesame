//! OpenSesame **client-core sdk** — local E2EE + sync cursors (ADR 0017).
//!
//! WIT: `wit/client/world.wit`. Server must only ever store ciphertext blobs.
//! Persist sealed blobs only (native path / JSON); never plaintext on disk.

use blake3::Hasher;
use chacha20poly1305::{
    aead::{Aead, KeyInit},
    Key, XChaCha20Poly1305, XNonce,
};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use thiserror::Error;
use zeroize::{Zeroize, ZeroizeOnDrop};

pub use opensesame_core as core;
pub use opensesame_human_vault as human_vault;

#[cfg(feature = "wasm-bindgen")]
pub mod wasm;

pub mod wit_contract {
    pub const PACKAGE: &str = "opensesame:client@1.0.0";
}

#[derive(Debug, Error)]
pub enum ClientCoreError {
    #[error("aead failure")]
    Aead,
    #[error("sync conflict: remote epoch {remote} <= local {local}")]
    StaleEpoch { local: u64, remote: u64 },
    #[error("missing device key")]
    MissingKey,
    #[error("persist io: {0}")]
    Persist(String),
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct SyncCursor {
    pub device_id: String,
    pub epoch: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct SyncBlob {
    pub id: String,
    pub epoch: u64,
    /// Opaque ciphertext — never log or decode on server.
    pub ciphertext: Vec<u8>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct PersistedStore {
    cursor: SyncCursor,
    /// Sealed entries only.
    blobs: Vec<SyncBlob>,
}

#[derive(Zeroize, ZeroizeOnDrop)]
pub struct DeviceKey {
    key: [u8; 32],
}

impl DeviceKey {
    pub fn generate() -> Self {
        let mut key = [0u8; 32];
        rand::thread_rng().fill_bytes(&mut key);
        Self { key }
    }

    pub fn from_bytes(key: [u8; 32]) -> Self {
        Self { key }
    }

    pub fn as_bytes(&self) -> &[u8; 32] {
        &self.key
    }
}

/// Seal plaintext with XChaCha20-Poly1305; AAD binds blob id.
pub fn seal(key: &DeviceKey, plaintext: &[u8], aad: &[u8]) -> Result<Vec<u8>, ClientCoreError> {
    let cipher = XChaCha20Poly1305::new(Key::from_slice(&key.key));
    let mut nonce_bytes = [0u8; 24];
    rand::thread_rng().fill_bytes(&mut nonce_bytes);
    let nonce = XNonce::from_slice(&nonce_bytes);
    let mut out = nonce_bytes.to_vec();
    let ct = cipher
        .encrypt(
            nonce,
            chacha20poly1305::aead::Payload {
                msg: plaintext,
                aad,
            },
        )
        .map_err(|_| ClientCoreError::Aead)?;
    out.extend(ct);
    Ok(out)
}

pub fn open(key: &DeviceKey, sealed: &[u8], aad: &[u8]) -> Result<Vec<u8>, ClientCoreError> {
    if sealed.len() < 24 {
        return Err(ClientCoreError::Aead);
    }
    let (nonce_bytes, ct) = sealed.split_at(24);
    let cipher = XChaCha20Poly1305::new(Key::from_slice(&key.key));
    let nonce = XNonce::from_slice(nonce_bytes);
    cipher
        .decrypt(nonce, chacha20poly1305::aead::Payload { msg: ct, aad })
        .map_err(|_| ClientCoreError::Aead)
}

/// Encrypted sync store — RAM + optional sealed-blob persistence (ciphertext only).
pub struct SyncStore {
    /// id -> (epoch, ciphertext)
    entries: BTreeMap<String, (u64, Vec<u8>)>,
    pub cursor: SyncCursor,
}

impl SyncStore {
    pub fn new(device_id: impl Into<String>) -> Self {
        Self {
            entries: BTreeMap::new(),
            cursor: SyncCursor {
                device_id: device_id.into(),
                epoch: 0,
            },
        }
    }

    pub fn put_local(
        &mut self,
        key: &DeviceKey,
        id: impl Into<String>,
        plaintext: &[u8],
    ) -> Result<SyncBlob, ClientCoreError> {
        let id = id.into();
        self.cursor.epoch = self.cursor.epoch.saturating_add(1);
        let aad = id.as_bytes();
        let ciphertext = seal(key, plaintext, aad)?;
        let epoch = self.cursor.epoch;
        self.entries.insert(id.clone(), (epoch, ciphertext.clone()));
        Ok(SyncBlob {
            id,
            epoch,
            ciphertext,
        })
    }

    /// Apply remote blobs. Last-writer-wins by higher epoch.
    pub fn apply_remote(&mut self, blobs: &[SyncBlob]) -> SyncCursor {
        for b in blobs {
            match self.entries.get(&b.id) {
                Some((ep, _)) if *ep > b.epoch => {}
                Some((ep, _)) if *ep == b.epoch => {}
                _ => {
                    self.entries
                        .insert(b.id.clone(), (b.epoch, b.ciphertext.clone()));
                    if b.epoch > self.cursor.epoch {
                        self.cursor.epoch = b.epoch;
                    }
                }
            }
        }
        self.cursor.clone()
    }

    pub fn collect_outgoing(&self, since: &SyncCursor) -> Vec<SyncBlob> {
        self.entries
            .iter()
            .filter(|(_, (ep, _))| *ep > since.epoch)
            .map(|(id, (epoch, ct))| SyncBlob {
                id: id.clone(),
                epoch: *epoch,
                ciphertext: ct.clone(),
            })
            .collect()
    }

    pub fn digest_ciphertext(ct: &[u8]) -> String {
        let mut h = Hasher::new();
        h.update(ct);
        h.finalize().to_hex().to_string()
    }

    /// Serialize sealed blobs + cursor (never plaintext).
    pub fn to_persisted_json(&self) -> Result<String, ClientCoreError> {
        let blobs: Vec<SyncBlob> = self
            .entries
            .iter()
            .map(|(id, (epoch, ct))| SyncBlob {
                id: id.clone(),
                epoch: *epoch,
                ciphertext: ct.clone(),
            })
            .collect();
        let p = PersistedStore {
            cursor: self.cursor.clone(),
            blobs,
        };
        serde_json::to_string(&p).map_err(|e| ClientCoreError::Persist(e.to_string()))
    }

    pub fn from_persisted_json(json: &str) -> Result<Self, ClientCoreError> {
        let p: PersistedStore =
            serde_json::from_str(json).map_err(|e| ClientCoreError::Persist(e.to_string()))?;
        let mut store = Self::new(p.cursor.device_id.clone());
        store.cursor = p.cursor;
        for b in p.blobs {
            store.entries.insert(b.id, (b.epoch, b.ciphertext));
        }
        Ok(store)
    }

    /// Native filesystem persistence (OPFS equivalent for browsers lives in packages/client-core).
    #[cfg(not(target_arch = "wasm32"))]
    pub fn save_path(&self, path: &std::path::Path) -> Result<(), ClientCoreError> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| ClientCoreError::Persist(e.to_string()))?;
        }
        let json = self.to_persisted_json()?;
        // Refuse to write if plaintext-looking keys somehow appear (defense in depth).
        if json.contains("\"plaintext\"") {
            return Err(ClientCoreError::Persist(
                "refusing to persist structure with plaintext field".into(),
            ));
        }
        std::fs::write(path, json).map_err(|e| ClientCoreError::Persist(e.to_string()))
    }

    #[cfg(not(target_arch = "wasm32"))]
    pub fn load_path(path: &std::path::Path) -> Result<Self, ClientCoreError> {
        let json =
            std::fs::read_to_string(path).map_err(|e| ClientCoreError::Persist(e.to_string()))?;
        Self::from_persisted_json(&json)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seal_open_roundtrip() {
        let key = DeviceKey::generate();
        let sealed = seal(&key, b"secret", b"item-1").unwrap();
        assert_ne!(&sealed[24..], b"secret");
        assert_eq!(open(&key, &sealed, b"item-1").unwrap(), b"secret");
    }

    #[test]
    fn sync_preserves_ids_and_epochs() {
        let key = DeviceKey::generate();
        let mut a = SyncStore::new("dev-a");
        let blob = a.put_local(&key, "note-1", b"hello").unwrap();
        let mut b = SyncStore::new("dev-b");
        b.apply_remote(&[blob.clone()]);
        assert_eq!(b.entries.get("note-1").unwrap().0, blob.epoch);
        let out = b.collect_outgoing(&SyncCursor {
            device_id: "x".into(),
            epoch: 0,
        });
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].id, "note-1");
    }

    #[test]
    fn server_view_is_ciphertext_only() {
        let key = DeviceKey::generate();
        let mut store = SyncStore::new("d");
        let blob = store
            .put_local(&key, "x", b"plaintext-should-not-leak")
            .unwrap();
        let json = serde_json::to_string(&blob).unwrap();
        assert!(!json.contains("plaintext-should-not-leak"));
    }

    #[test]
    fn multi_device_cursor_monotonic() {
        let key = DeviceKey::generate();
        let mut a = SyncStore::new("dev-a");
        let mut b = SyncStore::new("dev-b");
        let b1 = a.put_local(&key, "n1", b"one").unwrap();
        b.apply_remote(&[b1]);
        let e1 = b.cursor.epoch;
        let b2 = a.put_local(&key, "n2", b"two").unwrap();
        b.apply_remote(&[b2]);
        assert!(b.cursor.epoch >= e1);
        let since = SyncCursor {
            device_id: "dev-b".into(),
            epoch: e1,
        };
        let out = b.collect_outgoing(&since);
        assert!(out.iter().all(|x| x.epoch > e1));
        for blob in &out {
            let json = serde_json::to_string(blob).unwrap();
            assert!(!json.contains("one"));
            assert!(!json.contains("two"));
        }
    }

    #[test]
    fn persist_roundtrip_ciphertext_only() {
        let key = DeviceKey::generate();
        let mut store = SyncStore::new("persist-dev");
        store.put_local(&key, "n1", b"secret-payload-xyz").unwrap();
        let json = store.to_persisted_json().unwrap();
        assert!(!json.contains("secret-payload-xyz"));
        let loaded = SyncStore::from_persisted_json(&json).unwrap();
        assert_eq!(loaded.cursor.device_id, "persist-dev");
        assert_eq!(loaded.entries.len(), 1);

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("sync.json");
        store.save_path(&path).unwrap();
        let from_disk = SyncStore::load_path(&path).unwrap();
        assert_eq!(from_disk.cursor.epoch, store.cursor.epoch);
        let disk_json = std::fs::read_to_string(&path).unwrap();
        assert!(!disk_json.contains("secret-payload-xyz"));
    }
}
