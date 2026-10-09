//! Where fill reads entries from: the human-plane sealed store, through
//! `opensesame-sealed-store`'s own API (the one `opensesame pass` and the
//! browserpass/gopass bridges use). No second store, no cache.
//!
//! The store is unlocked per request and the item key is dropped — zeroized
//! by `ItemDataKey`'s own `Drop` — when the request's reader goes out of
//! scope, so no unlocked key lives in the daemon between fills. The
//! passphrase arrives the way it does for every non-interactive human-plane
//! reader: `OPENSESAME_STORE_PASSWORD`, copied and zeroized per unlock. A
//! GPG store needs none (the agent behind `gpg` asks); `.age` entries read
//! `OPENSESAME_AGE_IDENTITY`, as `pass show` does.

use opensesame_sealed_store::{
    resolve_store_dir, unlock_store_key, Entry, ItemDataKey, StoreError, StoreRoot,
};
use std::path::PathBuf;
use zeroize::Zeroize;

/// Store passphrase for a reader with no terminal (shared with the bridges).
pub(crate) const ENV_STORE_PASSWORD: &str = "OPENSESAME_STORE_PASSWORD";
/// Age identity for `.age` entries (shared with `pass show`).
pub(crate) const ENV_AGE_IDENTITY: &str = "OPENSESAME_AGE_IDENTITY";
/// Store fill reads, overriding `OPENSESAME_STORE_DIR` / `PASSWORD_STORE_DIR`.
pub(crate) const ENV_FILL_STORE_DIR: &str = "OPENSESAME_FILL_STORE_DIR";

/// Why a store could not answer. Nothing here carries a value.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum SourceError {
    /// The store is keyed and no passphrase is configured, or it is wrong.
    Locked,
    /// No such entry.
    Missing,
    /// The password was made by an older version from a pepper it asked for
    /// (ADR 0174): it is converted in the app, never produced here.
    Legacy,
    /// Anything else the store refused; the detail stays in the daemon.
    Failed,
}

/// One request's view of the store.
pub(crate) trait EntryReader {
    /// Every logical entry name.
    fn names(&self) -> Result<Vec<String>, SourceError>;
    /// Decrypt one entry.
    fn read(&self, name: &str) -> Result<Entry, SourceError>;
}

/// Opens a store for one request.
pub(crate) trait EntrySource: Send + Sync {
    fn open(&self) -> Result<Box<dyn EntryReader + '_>, SourceError>;
}

/// Where the store passphrase comes from.
enum Passphrase {
    /// `OPENSESAME_STORE_PASSWORD`, read per unlock.
    Env,
    /// Tests pass it in rather than race on the process environment.
    #[cfg(test)]
    Fixed(String),
}

/// The sealed store at a fixed root.
pub(crate) struct SealedSource {
    root: PathBuf,
    passphrase: Passphrase,
}

impl SealedSource {
    /// `OPENSESAME_FILL_STORE_DIR`, else the sealed store's usual chain. The
    /// tomb registry is not consulted: a daemon must not follow an "active
    /// tomb" a person switched to in some terminal.
    pub(crate) fn from_env() -> Self {
        let root = std::env::var_os(ENV_FILL_STORE_DIR)
            .filter(|dir| !dir.is_empty())
            .map_or_else(resolve_store_dir, PathBuf::from);
        Self {
            root,
            passphrase: Passphrase::Env,
        }
    }

    #[cfg(test)]
    pub(crate) fn at(root: PathBuf, passphrase: &str) -> Self {
        Self {
            root,
            passphrase: Passphrase::Fixed(passphrase.to_string()),
        }
    }

    fn passphrase(&self) -> Option<String> {
        match &self.passphrase {
            Passphrase::Env => std::env::var(ENV_STORE_PASSWORD)
                .ok()
                .filter(|p| !p.is_empty()),
            #[cfg(test)]
            Passphrase::Fixed(passphrase) => Some(passphrase.clone()),
        }
    }
}

struct SealedReader {
    store: StoreRoot,
    key: ItemDataKey,
}

impl EntrySource for SealedSource {
    fn open(&self) -> Result<Box<dyn EntryReader + '_>, SourceError> {
        let store = StoreRoot::open(&self.root).map_err(|_| SourceError::Failed)?;
        let key = if self.root.join(".opensesame-key").exists() {
            let mut password = self.passphrase().ok_or(SourceError::Locked)?;
            let key = unlock_store_key(&self.root, password.as_bytes());
            password.zeroize();
            key.map_err(|_| SourceError::Locked)?
        } else {
            // GPG and age stores decrypt through their own agent or identity;
            // the item key is never consulted on that path.
            ItemDataKey([0u8; 32])
        };
        Ok(Box::new(SealedReader { store, key }))
    }
}

impl EntryReader for SealedReader {
    fn names(&self) -> Result<Vec<String>, SourceError> {
        self.store.ls("").map_err(|_| SourceError::Failed)
    }

    fn read(&self, name: &str) -> Result<Entry, SourceError> {
        let mut identity = std::env::var(ENV_AGE_IDENTITY)
            .ok()
            .filter(|id| !id.is_empty());
        let entry = self
            .store
            .show_with_age_identity(name, &self.key, identity.as_deref());
        if let Some(id) = identity.as_mut() {
            id.zeroize();
        }
        entry.map_err(|error| match error {
            StoreError::NotFound(_) | StoreError::InvalidPath(_) => SourceError::Missing,
            StoreError::Age(_) => SourceError::Locked,
            _ => SourceError::Failed,
        })
    }
}

/// An in-memory store for route tests: no Argon2, no disk.
#[cfg(test)]
pub(crate) struct MemorySource {
    pub(crate) entries: Vec<(String, Entry)>,
    pub(crate) locked: bool,
}

#[cfg(test)]
impl EntrySource for MemorySource {
    fn open(&self) -> Result<Box<dyn EntryReader + '_>, SourceError> {
        if self.locked {
            return Err(SourceError::Locked);
        }
        Ok(Box::new(MemoryReader(&self.entries)))
    }
}

#[cfg(test)]
struct MemoryReader<'a>(&'a [(String, Entry)]);

#[cfg(test)]
impl EntryReader for MemoryReader<'_> {
    fn names(&self) -> Result<Vec<String>, SourceError> {
        Ok(self.0.iter().map(|(name, _)| name.clone()).collect())
    }

    fn read(&self, name: &str) -> Result<Entry, SourceError> {
        self.0
            .iter()
            .find(|(n, _)| n == name)
            .map(|(_, entry)| entry.clone())
            .ok_or(SourceError::Missing)
    }
}
