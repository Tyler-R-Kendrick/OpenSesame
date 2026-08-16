use std::path::{Path, PathBuf};

use thiserror::Error;

#[derive(Debug, Error)]
pub enum StoreError {
    #[error("invalid path: {0}")]
    InvalidPath(String),
    #[error("store not initialized at {0}")]
    NotInitialized(PathBuf),
    #[error("entry not found: {0}")]
    NotFound(String),
    #[error("entry already exists: {0}")]
    AlreadyExists(String),
    #[error("crypto: {0}")]
    Crypto(String),
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("git: {0}")]
    Git(String),
    #[error("gpg: {0}")]
    Gpg(String),
    #[error("age: {0}")]
    Age(String),
    #[error("{0}")]
    Other(String),
}

/// Opened store root directory.
#[derive(Debug, Clone)]
pub struct StoreRoot {
    pub path: PathBuf,
}

impl StoreRoot {
    pub fn open(path: impl AsRef<Path>) -> Result<Self, StoreError> {
        let path = path.as_ref().to_path_buf();
        if !path.exists() {
            return Err(StoreError::NotInitialized(path));
        }
        Ok(Self { path })
    }
}

/// Resolve store directory: `OPENSESAME_STORE_DIR` → `PASSWORD_STORE_DIR` → `~/.password-store`.
pub fn resolve_store_dir() -> PathBuf {
    if let Ok(p) = std::env::var("OPENSESAME_STORE_DIR") {
        if !p.is_empty() {
            return PathBuf::from(p);
        }
    }
    if let Ok(p) = std::env::var("PASSWORD_STORE_DIR") {
        if !p.is_empty() {
            return PathBuf::from(p);
        }
    }
    directories::UserDirs::new()
        .map(|u| u.home_dir().join(".password-store"))
        .unwrap_or_else(|| PathBuf::from(".password-store"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_prefers_opensesame_store_dir() {
        std::env::set_var("OPENSESAME_STORE_DIR", "/tmp/os-store-test");
        std::env::set_var("PASSWORD_STORE_DIR", "/tmp/pass-store-test");
        assert_eq!(resolve_store_dir(), PathBuf::from("/tmp/os-store-test"));
        std::env::remove_var("OPENSESAME_STORE_DIR");
        std::env::remove_var("PASSWORD_STORE_DIR");
    }
}
