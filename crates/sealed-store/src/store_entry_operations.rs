//! Entry removal, listing, search, and copy/move operations.

use super::{
    auto_commit, confined_remove, fs, ItemDataKey, Path, StoreError, StoreLock, StoreRoot,
    COMMIT_REMOVE,
};
use crate::path::relative_to_logical;

fn collect_entry_names(
    dir: &Path,
    root: &Path,
    prefix: &str,
    names: &mut Vec<String>,
) -> Result<(), StoreError> {
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        if entry.file_name().to_string_lossy().starts_with('.') {
            continue;
        }
        if path.is_dir() {
            collect_entry_names(&path, root, prefix, names)?;
            continue;
        }
        let Ok(relative) = path.strip_prefix(root) else {
            continue;
        };
        let Some(extension) = relative.extension().and_then(|value| value.to_str()) else {
            continue;
        };
        if !matches!(extension, "osseal" | "gpg" | "age") {
            continue;
        }
        let Ok(logical) = relative_to_logical(relative) else {
            continue;
        };
        if prefix.is_empty() || logical == prefix || logical.starts_with(&format!("{prefix}/")) {
            names.push(logical);
        }
    }
    Ok(())
}

impl StoreRoot {
    ///
    /// # Errors
    ///
    /// Returns an error when validation or the underlying operation fails.
    pub fn rm(&self, name: &str) -> Result<(), StoreError> {
        let (path, _) = self.find_existing(name)?;
        let rel = path
            .strip_prefix(&self.path)
            .map_err(|_| StoreError::InvalidPath("path escapes store root".into()))?;
        let _lock = StoreLock::shared(&self.path)?;
        confined_remove(&self.path, rel)?;
        auto_commit(&self.path, COMMIT_REMOVE)?;
        Ok(())
    }

    ///
    /// # Errors
    ///
    /// Returns an error when validation or the underlying operation fails.
    pub fn ls(&self, prefix: &str) -> Result<Vec<String>, StoreError> {
        let prefix = prefix.trim().trim_matches('/');
        let mut names = Vec::new();
        if !self.path.exists() {
            return Ok(names);
        }
        collect_entry_names(&self.path, &self.path, prefix, &mut names)?;
        names.sort();
        Ok(names)
    }

    ///
    /// # Errors
    ///
    /// Returns an error when validation or the underlying operation fails.
    pub fn find(&self, query: &str) -> Result<Vec<String>, StoreError> {
        let q = query.to_lowercase();
        Ok(self
            .ls("")?
            .into_iter()
            .filter(|n| n.to_lowercase().contains(&q))
            .collect())
    }

    ///
    /// # Errors
    ///
    /// Returns an error when validation or the underlying operation fails.
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

    ///
    /// # Errors
    ///
    /// Returns an error when validation or the underlying operation fails.
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
