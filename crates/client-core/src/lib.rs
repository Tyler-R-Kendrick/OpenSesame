//! OpenSesame **client-core sdk** — local E2EE + sync cursors (ADR 0017).
//!
//! WIT: `wit/client/world.wit`. Server must only ever store ciphertext blobs.

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
        .decrypt(
            nonce,
            chacha20poly1305::aead::Payload { msg: ct, aad },
        )
        .map_err(|_| ClientCoreError::Aead)
}

/// In-memory encrypted sync store (MVP). Persisted as sealed blobs only.
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

    /// Apply remote blobs. Last-writer-wins by higher epoch; ties prefer lexicographically greater id keep existing.
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
        let blob = store.put_local(&key, "x", b"plaintext-should-not-leak").unwrap();
        let json = serde_json::to_string(&blob).unwrap();
        assert!(!json.contains("plaintext-should-not-leak"));
    }
}
