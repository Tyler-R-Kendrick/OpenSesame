//! Pluggable object store beneath the confinement funnel (ADR 0065 §6).
//!
//! The sealed store's only I/O funnel is `path::confined_{read,write,remove}`.
//! A backend inserted *here* — below that funnel — sees only what the funnel
//! carries: **ciphertext**, addressed by a store-relative path. It never sees
//! a plaintext `Entry`, a passphrase, or a key, because those live above, at
//! the `StoreRoot` layer. That is the whole reason the seam is drawn here and
//! not there: a community backend (an encrypted volume, an object bucket, a
//! different on-disk layout) can be swapped in without ever touching secret
//! material.
//!
//! The default [`FsObjectStore`] is exactly the existing behavior: it
//! delegates to the symlink-refusing, traversal-fenced `confined_*` functions
//! rooted at the store directory. Alternate backends are held to the same
//! contract — relative paths only, no escape — by the [`ObjectStore`] trait's
//! path validation, which every implementation must run first.

use std::path::{Path, PathBuf};

use crate::path::{confined_read, confined_remove, confined_write, logical_to_relative};
use crate::StoreError;

/// A ciphertext object store keyed by store-relative path. Implementations
/// receive only sealed bytes; enforcing that is the caller's job above this
/// seam, and enforcing path safety is [`assert_confined_rel`] below it.
pub trait ObjectStore: Send + Sync {
    /// Read the object at `rel`, or `NotFound` when absent.
    ///
    /// # Errors
    ///
    /// Returns [`StoreError`] on an unsafe path or an I/O failure.
    fn get(&self, rel: &Path) -> Result<Vec<u8>, StoreError>;

    /// Write `bytes` (ciphertext) to `rel`, creating parents as needed.
    ///
    /// # Errors
    ///
    /// Returns [`StoreError`] on an unsafe path or an I/O failure.
    fn put(&self, rel: &Path, bytes: &[u8]) -> Result<(), StoreError>;

    /// Remove the object at `rel`.
    ///
    /// # Errors
    ///
    /// Returns [`StoreError`] on an unsafe path or an I/O failure.
    fn delete(&self, rel: &Path) -> Result<(), StoreError>;
}

/// Every `ObjectStore` implementation must reject an unsafe key before
/// touching a backend: a relative, traversal-free, NUL-free path. Reuses the
/// store's own `logical_to_relative` validation so a backend cannot widen
/// what the funnel already refuses.
///
/// # Errors
///
/// Returns [`StoreError::InvalidPath`] when `rel` is absolute, empty, or
/// contains a `.`/`..`/NUL segment.
pub fn assert_confined_rel(rel: &Path) -> Result<(), StoreError> {
    if rel.is_absolute() {
        return Err(StoreError::InvalidPath("absolute path".into()));
    }
    let as_str = rel
        .to_str()
        .ok_or_else(|| StoreError::InvalidPath("non-utf8 path".into()))?;
    // `logical_to_relative` is the canonical segment fence (no `.`/`..`/NUL,
    // no absolute, no empty). Round-tripping the relative path through it
    // proves the same invariants without duplicating them.
    logical_to_relative(as_str).map(|_| ())
}

/// The default backend: the filesystem, through the confinement funnel that
/// already refuses symlinks and traversal. Behavior is byte-for-byte the
/// pre-seam store.
pub struct FsObjectStore {
    root: PathBuf,
}

impl FsObjectStore {
    #[must_use]
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }
}

impl ObjectStore for FsObjectStore {
    fn get(&self, rel: &Path) -> Result<Vec<u8>, StoreError> {
        assert_confined_rel(rel)?;
        confined_read(&self.root, rel)
    }

    fn put(&self, rel: &Path, bytes: &[u8]) -> Result<(), StoreError> {
        assert_confined_rel(rel)?;
        confined_write(&self.root, rel, bytes)
    }

    fn delete(&self, rel: &Path) -> Result<(), StoreError> {
        assert_confined_rel(rel)?;
        confined_remove(&self.root, rel)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fs_store_round_trips_ciphertext_through_the_funnel() {
        let dir = tempfile::tempdir().unwrap();
        let store = FsObjectStore::new(dir.path());
        let rel = Path::new("Email/github.com.osseal");
        let ciphertext = b"OSSEAL1\n\x00\x01sealed-bytes";

        store.put(rel, ciphertext).unwrap();
        assert_eq!(store.get(rel).unwrap(), ciphertext);
        store.delete(rel).unwrap();
        assert!(matches!(
            store.get(rel),
            Err(StoreError::Io(_) | StoreError::NotFound(_))
        ));
    }

    #[test]
    fn unsafe_keys_are_refused_before_the_backend() {
        let dir = tempfile::tempdir().unwrap();
        let store = FsObjectStore::new(dir.path());
        for bad in ["../escape.osseal", "/etc/passwd", "a/../b", "with\0nul"] {
            assert!(store.get(Path::new(bad)).is_err(), "{bad} must be refused");
            assert!(store.put(Path::new(bad), b"x").is_err(), "{bad}");
            assert!(store.delete(Path::new(bad)).is_err(), "{bad}");
        }
        // The escape attempts wrote nothing outside the root.
        assert!(!dir.path().join("..").join("escape.osseal").exists());
    }

    #[test]
    fn assert_confined_rel_matches_logical_to_relative() {
        assert!(assert_confined_rel(Path::new("Dev/api-token.osseal")).is_ok());
        assert!(assert_confined_rel(Path::new("../x")).is_err());
        assert!(assert_confined_rel(Path::new("/abs")).is_err());
    }
}
