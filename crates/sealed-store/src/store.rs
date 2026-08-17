use std::fs;
use std::path::{Path, PathBuf};

use opensesame_human_vault::{
    unwrap_vrk_with_password, wrap_vrk_with_password, ItemDataKey, PasswordWrapper, VaultRootKey,
};

use crate::envelope::{open_osseal, seal_osseal};
use crate::git::auto_commit;
use crate::path::{logical_to_relative, relative_to_logical};
use crate::recipients::Recipients;
use crate::{age_fmt, gpg, Entry, StoreError, StoreRoot};

const KEY_FILE: &str = ".opensesame-key";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FormatHint {
    Osseal,
    Gpg,
    Age,
}

/// Initialize a store root with optional recipients and a fresh passphrase-wrapped VRK.
pub fn init_store(root: &Path, recipients: &[String]) -> Result<StoreRoot, StoreError> {
    fs::create_dir_all(root)?;
    Recipients::write(root, recipients)?;
    Ok(StoreRoot {
        path: root.to_path_buf(),
    })
}

/// Create `.opensesame-key` wrapping a new VRK under `password`.
pub fn init_store_key(root: &Path, password: &[u8]) -> Result<ItemDataKey, StoreError> {
    let vrk = VaultRootKey::generate();
    let wrapper =
        wrap_vrk_with_password(password, &vrk).map_err(|e| StoreError::Crypto(e.to_string()))?;
    let json = serde_json::to_string_pretty(&wrapper)
        .map_err(|e| StoreError::Crypto(e.to_string()))?;
    fs::write(root.join(KEY_FILE), json)?;
    // Derive a stable content key from VRK bytes for entry encryption.
    Ok(ItemDataKey(vrk.0))
}

pub fn unlock_store_key(root: &Path, password: &[u8]) -> Result<ItemDataKey, StoreError> {
    let path = root.join(KEY_FILE);
    if !path.exists() {
        return Err(StoreError::NotInitialized(root.to_path_buf()));
    }
    let json = fs::read_to_string(&path)?;
    let wrapper: PasswordWrapper =
        serde_json::from_str(&json).map_err(|e| StoreError::Crypto(e.to_string()))?;
    let vrk =
        unwrap_vrk_with_password(password, &wrapper).map_err(|e| StoreError::Crypto(e.to_string()))?;
    Ok(ItemDataKey(vrk.0))
}

impl StoreRoot {
    fn entry_path(&self, name: &str, ext: &str) -> Result<PathBuf, StoreError> {
        let rel = logical_to_relative(name)?;
        // Append, never `with_extension`: that would swallow the final label of
        // dotted names, colliding `github.com` and `github.org` into one file
        // and missing classic `pass` files like `github.com.gpg`.
        let mut file = rel.into_os_string();
        file.push(".");
        file.push(ext);
        Ok(self.path.join(file))
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

    pub fn insert(
        &self,
        name: &str,
        entry: &Entry,
        key: &ItemDataKey,
    ) -> Result<(), StoreError> {
        if self.find_existing(name).is_ok() {
            return Err(StoreError::AlreadyExists(name.into()));
        }
        self.write_entry(name, entry, key, None)?;
        auto_commit(&self.path, &format!("Add {name}"))?;
        Ok(())
    }

    pub fn insert_or_replace(
        &self,
        name: &str,
        entry: &Entry,
        key: &ItemDataKey,
    ) -> Result<(), StoreError> {
        let existing = self.find_existing(name).ok();
        let keep_format = existing.as_ref().map(|(_, h)| *h);
        if let Some((path, _)) = &existing {
            let _ = fs::remove_file(path);
        }
        self.write_entry(name, entry, key, keep_format)?;
        let msg = if existing.is_some() {
            format!("Edit {name}")
        } else {
            format!("Add {name}")
        };
        auto_commit(&self.path, &msg)?;
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
        if let Some((path, _)) = &existing {
            let _ = fs::remove_file(path);
        }
        self.write_entry(name, entry, key, keep_format)
    }

    fn write_entry(
        &self,
        name: &str,
        entry: &Entry,
        key: &ItemDataKey,
        format: Option<FormatHint>,
    ) -> Result<(), StoreError> {
        let plaintext = entry.render().into_bytes();
        let format = format.unwrap_or_else(|| self.preferred_write_format());
        match format {
            FormatHint::Osseal => {
                let path = self.entry_path(name, "osseal")?;
                if let Some(parent) = path.parent() {
                    fs::create_dir_all(parent)?;
                }
                let blob = seal_osseal(&plaintext, key)?;
                fs::write(path, blob)?;
            }
            FormatHint::Gpg => {
                let path = self.entry_path(name, "gpg")?;
                let recipients = gpg::read_gpg_id(&self.path)?;
                gpg::encrypt_gpg_file(&path, &plaintext, &recipients)?;
            }
            FormatHint::Age => {
                let path = self.entry_path(name, "age")?;
                let recipients = age_fmt::read_age_recipients(&self.path)?;
                age_fmt::encrypt_age_file(&path, &plaintext, &recipients)?;
            }
        }
        Ok(())
    }

    pub fn show(&self, name: &str, key: &ItemDataKey) -> Result<Entry, StoreError> {
        let (path, hint) = self.find_existing(name)?;
        let plaintext = match hint {
            FormatHint::Osseal => {
                let blob = fs::read(&path)?;
                open_osseal(&blob, key)?
            }
            FormatHint::Gpg => gpg::decrypt_gpg_file(&path)?,
            FormatHint::Age => {
                return Err(StoreError::Age(
                    "age decrypt requires identity; use CLI age identity env".into(),
                ));
            }
        };
        let text = String::from_utf8(plaintext)
            .map_err(|e| StoreError::Crypto(format!("utf8: {e}")))?;
        Ok(Entry::parse(&text))
    }

    /// Show with optional age identity (secret key string).
    pub fn show_with_age_identity(
        &self,
        name: &str,
        key: &ItemDataKey,
        age_identity: Option<&str>,
    ) -> Result<Entry, StoreError> {
        let (path, hint) = self.find_existing(name)?;
        let plaintext = match hint {
            FormatHint::Osseal => open_osseal(&fs::read(&path)?, key)?,
            FormatHint::Gpg => gpg::decrypt_gpg_file(&path)?,
            FormatHint::Age => {
                let id = age_identity.ok_or_else(|| {
                    StoreError::Age("OPENSESAME_AGE_IDENTITY required for .age entries".into())
                })?;
                age_fmt::decrypt_age_file(&path, id)?
            }
        };
        let text = String::from_utf8(plaintext)
            .map_err(|e| StoreError::Crypto(format!("utf8: {e}")))?;
        Ok(Entry::parse(&text))
    }

    pub fn rm(&self, name: &str) -> Result<(), StoreError> {
        let (path, _) = self.find_existing(name)?;
        fs::remove_file(path)?;
        auto_commit(&self.path, &format!("Remove {name}"))?;
        Ok(())
    }

    pub fn ls(&self, prefix: &str) -> Result<Vec<String>, StoreError> {
        let prefix = prefix.trim().trim_matches('/');
        let mut names = Vec::new();
        if !self.path.exists() {
            return Ok(names);
        }
        fn walk(dir: &Path, root: &Path, prefix: &str, names: &mut Vec<String>) -> Result<(), StoreError> {
            for entry in fs::read_dir(dir)? {
                let entry = entry?;
                let path = entry.path();
                let file_name = entry.file_name();
                let name = file_name.to_string_lossy();
                if name.starts_with('.') {
                    continue;
                }
                if path.is_dir() {
                    walk(&path, root, prefix, names)?;
                    continue;
                }
                let rel = match path.strip_prefix(root) {
                    Ok(r) => r,
                    Err(_) => continue,
                };
                let Some(ext) = rel.extension().and_then(|e| e.to_str()) else {
                    continue;
                };
                if !matches!(ext, "osseal" | "gpg" | "age") {
                    continue;
                }
                let Ok(logical) = relative_to_logical(rel) else {
                    continue;
                };
                if prefix.is_empty()
                    || logical == prefix
                    || logical.starts_with(&format!("{prefix}/"))
                {
                    names.push(logical);
                }
            }
            Ok(())
        }
        walk(&self.path, &self.path, prefix, &mut names)?;
        names.sort();
        Ok(names)
    }

    pub fn find(&self, query: &str) -> Result<Vec<String>, StoreError> {
        let q = query.to_lowercase();
        Ok(self
            .ls("")?
            .into_iter()
            .filter(|n| n.to_lowercase().contains(&q))
            .collect())
    }

    pub fn cp(
        &self,
        from: &str,
        to: &str,
        key: &ItemDataKey,
        age_identity: Option<&str>,
    ) -> Result<(), StoreError> {
        let entry = self.show_with_age_identity(from, key, age_identity)?;
        self.insert(to, &entry, key)?;
        Ok(())
    }

    pub fn mv(
        &self,
        from: &str,
        to: &str,
        key: &ItemDataKey,
        age_identity: Option<&str>,
    ) -> Result<(), StoreError> {
        let entry = self.show_with_age_identity(from, key, age_identity)?;
        self.insert(to, &entry, key)?;
        self.rm(from)?;
        Ok(())
    }
}

/// List entries for connector-host without unlocking (names only).
pub fn list_names(store_dir: &Path, prefix: &str) -> Result<Vec<String>, StoreError> {
    let root = StoreRoot::open(store_dir)?;
    root.ls(prefix)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn insert_show_ls_rm() {
        let dir = tempfile::tempdir().unwrap();
        let root = init_store(dir.path(), &[]).unwrap();
        let key = ItemDataKey([9u8; 32]);
        root.insert(
            "Dev/token",
            &Entry {
                secret: "abc".into(),
                trailer: String::new(),
            },
            &key,
        )
        .unwrap();
        assert_eq!(root.show("Dev/token", &key).unwrap().secret, "abc");
        assert!(root.ls("Dev").unwrap().iter().any(|n| n.contains("token")));
        root.rm("Dev/token").unwrap();
        assert!(root.show("Dev/token", &key).is_err());
    }

    #[test]
    fn dotted_names_keep_their_final_label() {
        let dir = tempfile::tempdir().unwrap();
        let root = init_store(dir.path(), &[]).unwrap();
        let key = ItemDataKey([4u8; 32]);
        for (name, secret) in [("Email/github.com", "a"), ("Email/github.org", "b")] {
            root.insert(
                name,
                &Entry {
                    secret: secret.into(),
                    trailer: String::new(),
                },
                &key,
            )
            .unwrap();
        }
        // Distinct files — `.com` is part of the name, not an extension.
        assert!(dir.path().join("Email/github.com.osseal").exists());
        assert!(dir.path().join("Email/github.org.osseal").exists());
        assert_eq!(root.show("Email/github.com", &key).unwrap().secret, "a");
        assert_eq!(root.show("Email/github.org", &key).unwrap().secret, "b");
        let names = root.ls("Email").unwrap();
        assert!(names.contains(&"Email/github.com".to_string()));
        assert!(names.contains(&"Email/github.org".to_string()));
    }

    #[test]
    fn passphrase_wrap_round_trip() {
        let dir = tempfile::tempdir().unwrap();
        let root = init_store(dir.path(), &["alice".into()]).unwrap();
        let key = init_store_key(dir.path(), b"correct horse").unwrap();
        root.insert(
            "x",
            &Entry {
                secret: "v".into(),
                trailer: String::new(),
            },
            &key,
        )
        .unwrap();
        let unlocked = unlock_store_key(dir.path(), b"correct horse").unwrap();
        assert_eq!(root.show("x", &unlocked).unwrap().secret, "v");
        assert!(unlock_store_key(dir.path(), b"wrong").is_err());
    }
}
