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
    ///
    /// # Errors
    ///
    /// Returns an error when validation or the underlying operation fails.
    pub fn open(path: impl AsRef<Path>) -> Result<Self, StoreError> {
        let path = path.as_ref().to_path_buf();
        if !path.exists() {
            return Err(StoreError::NotInitialized(path));
        }
        Ok(Self { path })
    }
}

/// Resolve store directory: `OPENSESAME_STORE_DIR` → `PASSWORD_STORE_DIR` → `~/.password-store`.
#[must_use]
pub fn resolve_store_dir() -> PathBuf {
    resolve_from(
        std::env::var("OPENSESAME_STORE_DIR").ok().as_deref(),
        std::env::var("PASSWORD_STORE_DIR").ok().as_deref(),
    )
}

/// The precedence rule itself, with the environment lifted out.
///
/// Reading the two variables is the only thing [`resolve_store_dir`] adds, and
/// keeping the rule pure is what lets the tests below cover every branch
/// without touching process-global state. The test this replaced set both
/// variables directly: Rust runs tests as threads in one process, so that
/// raced with anything else reading them; it cleared rather than restored
/// them, so it deleted a developer's real `PASSWORD_STORE_DIR`; it left them
/// set if an assert panicked; and it still only exercised one of the three
/// branches.
fn resolve_from(opensesame: Option<&str>, password_store: Option<&str>) -> PathBuf {
    for candidate in [opensesame, password_store].into_iter().flatten() {
        if !candidate.is_empty() {
            return PathBuf::from(candidate);
        }
    }
    directories::UserDirs::new().map_or_else(
        || PathBuf::from(".password-store"),
        |u| u.home_dir().join(".password-store"),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn default_dir() -> PathBuf {
        directories::UserDirs::new().map_or_else(
            || PathBuf::from(".password-store"),
            |u| u.home_dir().join(".password-store"),
        )
    }

    #[test]
    fn opensesame_store_dir_wins() {
        assert_eq!(
            resolve_from(Some("/srv/os-store"), Some("/srv/pass-store")),
            PathBuf::from("/srv/os-store")
        );
    }

    #[test]
    fn falls_back_to_password_store_dir() {
        assert_eq!(
            resolve_from(None, Some("/srv/pass-store")),
            PathBuf::from("/srv/pass-store")
        );
    }

    #[test]
    fn an_empty_value_does_not_count_as_set() {
        assert_eq!(
            resolve_from(Some(""), Some("/srv/pass-store")),
            PathBuf::from("/srv/pass-store")
        );
        assert_eq!(resolve_from(Some(""), Some("")), default_dir());
    }

    #[test]
    fn falls_back_to_the_home_store_when_neither_is_set() {
        assert_eq!(resolve_from(None, None), default_dir());
    }
}
