use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use opensesame_human_vault::root_protection::{
    init_versioned_key_file, unlock_key_file_with_password,
};
use opensesame_human_vault::ItemDataKey;

use crate::envelope::{open_osseal, seal_osseal};
use crate::git::auto_commit;
use crate::path::{confined_read, confined_remove, confined_write, logical_to_relative};
use crate::recipients::Recipients;
use crate::store_lock::StoreLock;
use crate::{age_fmt, gpg, Entry, StoreError, StoreRoot};

#[path = "store_entry_operations.rs"]
mod entry_operations;

const KEY_FILE: &str = ".opensesame-key";
const REVISION_FILE: &str = ".opensesame-revisions.json";

// Commit subjects name the operation, never the entry. A backup remote holds
// the whole history, so an entry name in a commit subject publishes the folder
// tree, the item names, and their change cadence to anyone who can read the
// repository — the ciphertext beside it stays sealed, but the metadata does not.
pub(crate) const COMMIT_ADD: &str = "seal: add entry";
pub(crate) const COMMIT_EDIT: &str = "seal: edit entry";
pub(crate) const COMMIT_REMOVE: &str = "seal: remove entry";
pub(crate) const COMMIT_REBIND: &str = "seal: rebind entry encryption context";
pub(crate) const COMMIT_RESTORE: &str = "seal: restore entry";
pub(crate) const COMMIT_ATTACH: &str = "seal: add attachment";
pub(crate) const COMMIT_DETACH: &str = "seal: remove attachment";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FormatHint {
    Osseal,
    Gpg,
    Age,
}

/// Initialize a store root with optional recipients and a fresh passphrase-wrapped VRK.
///
/// # Errors
///
/// Returns an error when validation or the underlying operation fails.
pub fn init_store(root: &Path, recipients: &[String]) -> Result<StoreRoot, StoreError> {
    fs::create_dir_all(root)?;
    Recipients::write(root, recipients)?;
    Ok(StoreRoot {
        path: root.to_path_buf(),
    })
}

/// Create `.opensesame-key` wrapping a new VRK under `password`.
///
/// # Errors
///
/// Returns an error when validation or the underlying operation fails.
pub fn init_store_key(root: &Path, password: &[u8]) -> Result<ItemDataKey, StoreError> {
    // Versioned root-protection manifest; content key remains ItemDataKey(vrk.0).
    let (idk, _manifest) =
        init_versioned_key_file(root, password).map_err(|e| StoreError::Crypto(e.to_string()))?;
    Ok(idk)
}

///
/// # Errors
///
/// Returns an error when validation or the underlying operation fails.
pub fn unlock_store_key(root: &Path, password: &[u8]) -> Result<ItemDataKey, StoreError> {
    let path = root.join(KEY_FILE);
    if !path.exists() {
        return Err(StoreError::NotInitialized(root.to_path_buf()));
    }
    // Legacy password wrappers and versioned manifests both map to ItemDataKey(vrk.0).
    let (idk, _contents, _vrk) = unlock_key_file_with_password(root, password)
        .map_err(|e| StoreError::Crypto(e.to_string()))?;
    Ok(idk)
}

impl StoreRoot {
    pub(crate) fn revisions(&self) -> Result<BTreeMap<String, u64>, StoreError> {
        let path = self.path.join(REVISION_FILE);
        if !path.exists() {
            return Ok(BTreeMap::new());
        }
        serde_json::from_slice(&confined_read(&self.path, Path::new(REVISION_FILE))?)
            .map_err(|e| StoreError::Crypto(format!("invalid revision state: {e}")))
    }

    fn record_revision(&self, name: &str, revision: u64) -> Result<(), StoreError> {
        let mut revisions = self.revisions()?;
        revisions.insert(name.to_string(), revision);
        let bytes = serde_json::to_vec(&revisions)
            .map_err(|e| StoreError::Crypto(format!("revision state: {e}")))?;
        confined_write(&self.path, Path::new(REVISION_FILE), &bytes)?;
        Ok(())
    }

    fn next_revision(&self, name: &str, path: &Path, key: &ItemDataKey) -> Result<u64, StoreError> {
        let current = match self.revisions()?.get(name).copied() {
            Some(revision) => revision,
            None if path.exists() => {
                let rel = path
                    .strip_prefix(&self.path)
                    .map_err(|_| StoreError::InvalidPath("path escapes store root".into()))?;
                open_osseal(&confined_read(&self.path, rel)?, key, name, None)?.revision
            }
            None => 0,
        };
        let next = current
            .checked_add(1)
            .ok_or_else(|| StoreError::Crypto("entry revision exhausted".into()))?;
        // Advance trusted local state before replacing ciphertext: a crash may
        // require rewriting the entry, but can never make an older blob valid.
        self.record_revision(name, next)?;
        Ok(next)
    }

    fn entry_path(&self, name: &str, ext: &str) -> Result<PathBuf, StoreError> {
        Ok(self.path.join(Self::entry_relative(name, ext)?))
    }

    pub(crate) fn entry_relative(name: &str, ext: &str) -> Result<PathBuf, StoreError> {
        let rel = logical_to_relative(name)?;
        // Append, never `with_extension`: that would swallow the final label of
        // dotted names, colliding `github.com` and `github.org` into one file
        // and missing classic `pass` files like `github.com.gpg`.
        let mut file = rel.into_os_string();
        file.push(".");
        file.push(ext);
        Ok(PathBuf::from(file))
    }

    fn find_existing(&self, name: &str) -> Result<(PathBuf, FormatHint), StoreError> {
        for (ext, hint) in [
            ("osseal", FormatHint::Osseal),
            ("gpg", FormatHint::Gpg),
            ("age", FormatHint::Age),
        ] {
            let p = self.entry_path(name, ext)?;
            if p.exists() {
                return Ok((p, hint));
            }
        }
        Err(StoreError::NotFound(name.into()))
    }

    fn preferred_write_format(&self) -> FormatHint {
        let has_os =
            self.path.join(".opensesame-recipients").exists() || self.path.join(KEY_FILE).exists();
        let has_gpg = self.path.join(".gpg-id").exists();
        let has_age = self.path.join(".age-recipients").exists();
        if has_os && !has_gpg {
            FormatHint::Osseal
        } else if has_gpg && !has_os {
            FormatHint::Gpg
        } else if has_age && !has_os && !has_gpg {
            FormatHint::Age
        } else if has_os {
            FormatHint::Osseal
        } else if has_gpg {
            FormatHint::Gpg
        } else if has_age {
            FormatHint::Age
        } else {
            FormatHint::Osseal
        }
    }

    ///
    /// # Errors
    ///
    /// Returns an error when validation or the underlying operation fails.
    pub fn insert(&self, name: &str, entry: &Entry, key: &ItemDataKey) -> Result<(), StoreError> {
        if self.find_existing(name).is_ok() {
            return Err(StoreError::AlreadyExists(name.into()));
        }
        self.write_entry(name, entry, key, None)?;
        auto_commit(&self.path, COMMIT_ADD)?;
        Ok(())
    }

    ///
    /// # Errors
    ///
    /// Returns an error when validation or the underlying operation fails.
    pub fn insert_or_replace(
        &self,
        name: &str,
        entry: &Entry,
        key: &ItemDataKey,
    ) -> Result<(), StoreError> {
        let existing = self.find_existing(name).ok();
        let keep_format = existing.as_ref().map(|(_, h)| *h);
        self.write_entry(name, entry, key, keep_format)?;
        let msg = if existing.is_some() {
            COMMIT_EDIT
        } else {
            COMMIT_ADD
        };
        auto_commit(&self.path, msg)?;
        Ok(())
    }

    /// Write (or overwrite) an entry without committing — manifest sealing
    /// batches many writes into one commit.
    pub(crate) fn write_entry_unchecked(
        &self,
        name: &str,
        entry: &Entry,
        key: &ItemDataKey,
    ) -> Result<(), StoreError> {
        let existing = self.find_existing(name).ok();
        let keep_format = existing.as_ref().map(|(_, h)| *h);
        self.write_entry(name, entry, key, keep_format)
    }

    fn write_entry(
        &self,
        name: &str,
        entry: &Entry,
        key: &ItemDataKey,
        format: Option<FormatHint>,
    ) -> Result<(), StoreError> {
        // Held until the ciphertext is on disk: see `store_lock`.
        let _lock = StoreLock::for_sealing(&self.path, name, key)?;
        let plaintext = entry.render().into_bytes();
        let format = format.unwrap_or_else(|| self.preferred_write_format());
        match format {
            FormatHint::Osseal => {
                let rel = Self::entry_relative(name, "osseal")?;
                let path = self.path.join(&rel);
                let revision = self.next_revision(name, &path, key)?;
                let blob = seal_osseal(&plaintext, key, name, revision)?;
                confined_write(&self.path, &rel, &blob)?;
            }
            FormatHint::Gpg => {
                let rel = Self::entry_relative(name, "gpg")?;
                let recipients = gpg::read_gpg_id(&self.path)?;
                let ciphertext = gpg::encrypt_gpg(&plaintext, &recipients)?;
                confined_write(&self.path, &rel, &ciphertext)?;
            }
            FormatHint::Age => {
                let rel = Self::entry_relative(name, "age")?;
                let recipients = age_fmt::read_age_recipients(&self.path)?;
                let ciphertext = age_fmt::encrypt_age(&plaintext, &recipients)?;
                confined_write(&self.path, &rel, &ciphertext)?;
            }
        }
        Ok(())
    }

    ///
    /// # Errors
    ///
    /// Returns an error when validation or the underlying operation fails.
    pub fn show(&self, name: &str, key: &ItemDataKey) -> Result<Entry, StoreError> {
        if self.find_existing(name)?.1 == FormatHint::Age {
            return Err(StoreError::Age(
                "age decrypt requires identity; use CLI age identity env".into(),
            ));
        }
        self.show_with_age_identity(name, key, None)
    }

    /// Show with optional age identity (secret key string).
    ///
    /// # Errors
    ///
    /// Returns an error when validation or the underlying operation fails.
    pub fn show_with_age_identity(
        &self,
        name: &str,
        key: &ItemDataKey,
        age_identity: Option<&str>,
    ) -> Result<Entry, StoreError> {
        self.show_with_optional_key(name, Some(key), age_identity)
    }

    /// Show an entry with an optional unlocked native key and age identity.
    /// GPG and age entries use their own decryption credentials. A native
    /// entry must have a key; absence never selects a fallback key or format.
    ///
    /// # Errors
    ///
    /// Returns [`StoreError::NotInitialized`] for a native entry without a key,
    /// or an error when path validation, decryption or the underlying IO fails.
    pub fn show_with_optional_key(
        &self,
        name: &str,
        key: Option<&ItemDataKey>,
        age_identity: Option<&str>,
    ) -> Result<Entry, StoreError> {
        let (path, hint) = self.find_existing(name)?;
        let rel = path
            .strip_prefix(&self.path)
            .map_err(|_| StoreError::InvalidPath("path escapes store root".into()))?;
        let (plaintext, rebind_key) = match hint {
            FormatHint::Osseal => {
                let key = key.ok_or_else(|| StoreError::NotInitialized(self.path.clone()))?;
                let expected = self.revisions()?.get(name).copied();
                let opened = open_osseal(&confined_read(&self.path, rel)?, key, name, expected)?;
                if !opened.legacy && expected.is_none() {
                    self.record_revision(name, opened.revision)?;
                }
                (opened.plaintext, opened.legacy.then_some(key))
            }
            FormatHint::Gpg => (gpg::decrypt_gpg(&confined_read(&self.path, rel)?)?, None),
            FormatHint::Age => {
                let id = age_identity.ok_or_else(|| {
                    StoreError::Age("OPENSESAME_AGE_IDENTITY required for .age entries".into())
                })?;
                (
                    age_fmt::decrypt_age(&confined_read(&self.path, rel)?, id)?,
                    None,
                )
            }
        };
        let text =
            String::from_utf8(plaintext).map_err(|e| StoreError::Crypto(format!("utf8: {e}")))?;
        let entry = Entry::parse(&text);
        if let Some(key) = rebind_key {
            self.write_entry(name, &entry, key, Some(FormatHint::Osseal))?;
            auto_commit(&self.path, COMMIT_REBIND)?;
        }
        Ok(entry)
    }
}

/// List entries for connector-host without unlocking (names only).
///
/// # Errors
///
/// Returns an error when validation or the underlying operation fails.
pub fn list_names(store_dir: &Path, prefix: &str) -> Result<Vec<String>, StoreError> {
    let root = StoreRoot::open(store_dir)?;
    root.ls(prefix)
}

#[cfg(test)]
#[path = "store_tests.rs"]
mod tests;
