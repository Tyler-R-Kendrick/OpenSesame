use std::path::Path;
use std::process::Command;

use crate::StoreError;

pub fn ensure_git_repo(root: &Path) -> Result<(), StoreError> {
    if !root.join(".git").exists() {
        let status = Command::new("git")
            .args(["init"])
            .current_dir(root)
            .status()
            .map_err(|e| StoreError::Git(e.to_string()))?;
        if !status.success() {
            return Err(StoreError::Git("git init failed".into()));
        }
    }
    // Local identity for the store repo only (not the OpenSesame project).
    let _ = Command::new("git")
        .args(["config", "user.email", "opensesame-store@localhost"])
        .current_dir(root)
        .status();
    let _ = Command::new("git")
        .args(["config", "user.name", "OpenSesame Store"])
        .current_dir(root)
        .status();
    Ok(())
}

/// Commit all changes when `root` is a git repository. No-op otherwise.
pub fn auto_commit(root: &Path, message: &str) -> Result<(), StoreError> {
    if !root.join(".git").exists() {
        return Ok(());
    }
    let _ = ensure_git_repo(root);
    let add = Command::new("git")
        .args(["add", "-A"])
        .current_dir(root)
        .status()
        .map_err(|e| StoreError::Git(e.to_string()))?;
    if !add.success() {
        return Err(StoreError::Git("git add failed".into()));
    }
    // Empty commit is fine to skip when nothing staged changes.
    let status = Command::new("git")
        .args(["diff", "--cached", "--quiet"])
        .current_dir(root)
        .status()
        .map_err(|e| StoreError::Git(e.to_string()))?;
    if status.success() {
        // exit 0 => no diff
        return Ok(());
    }
    let commit = Command::new("git")
        .args(["commit", "-m", message])
        .current_dir(root)
        .status()
        .map_err(|e| StoreError::Git(e.to_string()))?;
    if !commit.success() {
        // Non-fatal: store mutation already succeeded; caller can `opensesame pass git` later.
        eprintln!("warning: git commit failed for sealed store (is user.email configured?)");
    }
    Ok(())
}

pub fn git_passthrough(root: &Path, args: &[String]) -> Result<i32, StoreError> {
    let status = Command::new("git")
        .args(args)
        .current_dir(root)
        .status()
        .map_err(|e| StoreError::Git(e.to_string()))?;
    Ok(status.code().unwrap_or(1))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{init_store, Entry, ItemDataKey};
    use std::process::Command;

    #[test]
    fn auto_commit_records_insert() {
        let dir = tempfile::tempdir().unwrap();
        let init = Command::new("git")
            .args(["init"])
            .current_dir(dir.path())
            .status()
            .unwrap();
        assert!(init.success());
        let _ = Command::new("git")
            .args(["config", "user.email", "test@example.com"])
            .current_dir(dir.path())
            .status();
        let _ = Command::new("git")
            .args(["config", "user.name", "Test"])
            .current_dir(dir.path())
            .status();

        let root = init_store(dir.path(), &[]).unwrap();
        let key = ItemDataKey([1u8; 32]);
        root.insert(
            "a",
            &Entry {
                secret: "x".into(),
                trailer: String::new(),
                otp: None,
            },
            &key,
        )
        .unwrap();
        auto_commit(dir.path(), "Add a").unwrap();
        let log = Command::new("git")
            .args(["-C", dir.path().to_str().unwrap(), "log", "-1", "--pretty=%s"])
            .output()
            .unwrap();
        assert!(String::from_utf8_lossy(&log.stdout).contains("Add a"));
    }
}
