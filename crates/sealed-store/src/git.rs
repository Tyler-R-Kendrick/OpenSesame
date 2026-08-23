use std::path::Path;
use std::process::Command;

use crate::StoreError;

/// Environment variable the push credential helper reads the token from, so
/// the token never appears in argv or the process list.
pub const GIT_TOKEN_ENV: &str = "OPENSESAME_GIT_TOKEN";
const REMOTE: &str = "origin";
/// Git config key gating best-effort push after every auto-commit.
const AUTOPUSH_KEY: &str = "opensesame.autopush";

/// Most `git add` invocations we will hand paths to at once. One attachment can
/// contribute a thousand chunk objects, which would overrun the argument limit.
const ADD_BATCH: usize = 100;

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

/// Commit only ciphertext and store configuration when `root` is a git repository.
pub fn auto_commit(root: &Path, message: &str) -> Result<(), StoreError> {
    if !root.join(".git").exists() {
        eprintln!(
            "note: {} is not a git repository — the entry was written but not committed; \
             run `opensesame pass git init` to start tracking ciphertext history",
            root.display()
        );
        return Ok(());
    }
    let _ = ensure_git_repo(root);
    let listed = Command::new("git")
        .args(["ls-files", "-co", "--exclude-standard", "-z"])
        .current_dir(root)
        .output()
        .map_err(|e| StoreError::Git(e.to_string()))?;
    if !listed.status.success() {
        return Err(StoreError::Git("git ls-files failed".into()));
    }
    let paths: Vec<_> = listed
        .stdout
        .split(|byte| *byte == 0)
        .filter_map(|bytes| std::str::from_utf8(bytes).ok())
        .filter(|path| {
            matches!(
                *path,
                ".opensesame-key" | ".opensesame-recipients" | ".gpg-id" | ".age-recipients"
            ) || path.ends_with(".osseal")
                || path.ends_with(".gpg")
                || path.ends_with(".age")
                // Attachment ciphertext (ADR 0054). Both are sealed bytes, so
                // they travel under the same "only ciphertext leaves" rule as
                // entries. The attachment revision map stays local, like the
                // entry one, and is deliberately absent from this list.
                || path.ends_with(".osattach")
                || path.ends_with(".oschunk")
        })
        .collect();
    if paths.is_empty() {
        return Ok(());
    }
    for batch in paths.chunks(ADD_BATCH) {
        let add = Command::new("git")
            .args(["add", "-A", "--"])
            .args(batch)
            .current_dir(root)
            .status()
            .map_err(|e| StoreError::Git(e.to_string()))?;
        if !add.success() {
            return Err(StoreError::Git("git add failed".into()));
        }
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
        return Ok(());
    }
    match remote_url(root) {
        None => {
            eprintln!(
                "warning: sealed store has no git remote — ciphertext is local-only and not recoverable if this machine is lost; \
                 run `opensesame pass remote set <url>` then `opensesame pass backup`, or enable autopush"
            );
        }
        Some(_) if auto_push_enabled(root) => {
            // Best-effort: a backup that lags is recoverable, a blocked insert is not.
            if let Err(e) = push_backup(root, None) {
                eprintln!("warning: auto-push failed ({e}); run `opensesame pass backup` to retry");
            }
        }
        Some(_) => {
            eprintln!(
                "warning: sealed store has a remote but autopush is off — run `opensesame pass backup` \
                 or `git config opensesame.autopush true` so regenerations reach GitHub"
            );
        }
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

/// The configured backup remote, when one exists.
pub fn remote_url(root: &Path) -> Option<String> {
    let output = Command::new("git")
        .args(["remote", "get-url", REMOTE])
        .current_dir(root)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let url = String::from_utf8_lossy(&output.stdout).trim().to_string();
    (!url.is_empty()).then_some(url)
}

/// Point the backup remote at `url`, creating or updating `origin`.
pub fn set_remote(root: &Path, url: &str) -> Result<(), StoreError> {
    ensure_git_repo(root)?;
    let sub = if remote_url(root).is_some() {
        "set-url"
    } else {
        "add"
    };
    let status = Command::new("git")
        .args(["remote", sub, REMOTE, url])
        .current_dir(root)
        .status()
        .map_err(|e| StoreError::Git(e.to_string()))?;
    if !status.success() {
        return Err(StoreError::Git(format!("git remote {sub} failed")));
    }
    Ok(())
}

pub fn auto_push_enabled(root: &Path) -> bool {
    Command::new("git")
        .args(["config", "--get", AUTOPUSH_KEY])
        .current_dir(root)
        .output()
        .map(|o| o.status.success() && String::from_utf8_lossy(&o.stdout).trim() == "true")
        .unwrap_or(false)
}

pub fn set_auto_push(root: &Path, enabled: bool) -> Result<(), StoreError> {
    let status = Command::new("git")
        .args([
            "config",
            AUTOPUSH_KEY,
            if enabled { "true" } else { "false" },
        ])
        .current_dir(root)
        .status()
        .map_err(|e| StoreError::Git(e.to_string()))?;
    if !status.success() {
        return Err(StoreError::Git("git config failed".into()));
    }
    Ok(())
}

/// Push the store's current branch to `origin`, setting the upstream on first
/// push. With `token`, HTTPS pushes authenticate as `x-access-token` (the
/// username GitHub expects for OAuth/App installation tokens); the token
/// travels via [`GIT_TOKEN_ENV`] in the child environment, never argv.
pub fn push_backup(root: &Path, token: Option<&str>) -> Result<(), StoreError> {
    if remote_url(root).is_none() {
        return Err(StoreError::Git(
            "no backup remote configured; run `opensesame pass backup --remote <url>`".into(),
        ));
    }
    let mut cmd = Command::new("git");
    if let Some(token) = token {
        let helper = format!(
            "!f() {{ echo username=x-access-token; echo \"password=${GIT_TOKEN_ENV}\"; }}; f"
        );
        cmd.env(GIT_TOKEN_ENV, token)
            .arg("-c")
            .arg(format!("credential.helper={helper}"));
    }
    let output = cmd
        .args(["push", "-u", REMOTE, "HEAD"])
        .current_dir(root)
        .output()
        .map_err(|e| StoreError::Git(e.to_string()))?;
    if !output.status.success() {
        return Err(StoreError::Git(format!(
            "git push failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        )));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{init_store, Entry, ItemDataKey};
    use std::process::Command;

    fn git_init(dir: &Path) {
        let init = Command::new("git")
            .args(["init"])
            .current_dir(dir)
            .status()
            .unwrap();
        assert!(init.success());
        let _ = Command::new("git")
            .args(["config", "user.email", "test@example.com"])
            .current_dir(dir)
            .status();
        let _ = Command::new("git")
            .args(["config", "user.name", "Test"])
            .current_dir(dir)
            .status();
    }

    fn tracked_files(dir: &Path) -> String {
        let tree = Command::new("git")
            .args([
                "-C",
                dir.to_str().unwrap(),
                "ls-tree",
                "-r",
                "--name-only",
                "HEAD",
            ])
            .output()
            .unwrap();
        String::from_utf8_lossy(&tree.stdout).into_owned()
    }

    #[test]
    fn auto_commit_records_insert() {
        let dir = tempfile::tempdir().unwrap();
        git_init(dir.path());

        let root = init_store(dir.path(), &[]).unwrap();
        std::fs::write(dir.path().join("manifest.json"), r#"[{"secret":"leak"}]"#).unwrap();
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
            .args([
                "-C",
                dir.path().to_str().unwrap(),
                "log",
                "-1",
                "--pretty=%s",
            ])
            .output()
            .unwrap();
        assert!(String::from_utf8_lossy(&log.stdout).contains("Add a"));
        assert!(!tracked_files(dir.path()).contains("manifest.json"));
    }

    #[test]
    fn attachment_ciphertext_is_committed_but_local_state_is_not() {
        let dir = tempfile::tempdir().unwrap();
        git_init(dir.path());
        init_store(dir.path(), &[]).unwrap();

        // Stand in for what an attachment writes: a manifest, a chunk object,
        // and the local-only revision map.
        std::fs::create_dir_all(dir.path().join(".attachments/objects/ab")).unwrap();
        std::fs::create_dir_all(dir.path().join("Taxes")).unwrap();
        std::fs::write(dir.path().join("Taxes/w2.osattach"), b"sealed manifest").unwrap();
        std::fs::write(
            dir.path().join(".attachments/objects/ab/abcd.oschunk"),
            b"sealed chunk",
        )
        .unwrap();
        std::fs::write(
            dir.path().join(".opensesame-attachment-revisions.json"),
            b"{}",
        )
        .unwrap();

        auto_commit(dir.path(), "Attach Taxes/w2").unwrap();
        let tracked = tracked_files(dir.path());
        assert!(tracked.contains("Taxes/w2.osattach"), "{tracked}");
        assert!(tracked.contains("abcd.oschunk"), "{tracked}");
        assert!(
            !tracked.contains("attachment-revisions"),
            "anti-rollback state is local-only: {tracked}"
        );
    }

    #[test]
    fn remote_round_trip_and_autopush_flag() {
        let dir = tempfile::tempdir().unwrap();
        git_init(dir.path());
        assert!(remote_url(dir.path()).is_none());
        set_remote(dir.path(), "https://github.com/example/store.git").unwrap();
        assert_eq!(
            remote_url(dir.path()).as_deref(),
            Some("https://github.com/example/store.git")
        );
        // set-url path
        set_remote(dir.path(), "https://github.com/example/other.git").unwrap();
        assert_eq!(
            remote_url(dir.path()).as_deref(),
            Some("https://github.com/example/other.git")
        );
        assert!(!auto_push_enabled(dir.path()));
        set_auto_push(dir.path(), true).unwrap();
        assert!(auto_push_enabled(dir.path()));
        set_auto_push(dir.path(), false).unwrap();
        assert!(!auto_push_enabled(dir.path()));
    }

    #[test]
    fn push_backup_to_local_bare_remote() {
        let store = tempfile::tempdir().unwrap();
        let bare = tempfile::tempdir().unwrap();
        assert!(Command::new("git")
            .args(["init", "--bare"])
            .current_dir(bare.path())
            .status()
            .unwrap()
            .success());
        git_init(store.path());
        let root = init_store(store.path(), &[]).unwrap();
        let key = ItemDataKey([2u8; 32]);
        root.insert(
            "b",
            &Entry {
                secret: "y".into(),
                trailer: String::new(),
                otp: None,
            },
            &key,
        )
        .unwrap();
        set_remote(store.path(), bare.path().to_str().unwrap()).unwrap();
        push_backup(store.path(), None).unwrap();
        let log = Command::new("git")
            .args(["log", "-1", "--pretty=%s"])
            .current_dir(bare.path())
            .output()
            .unwrap();
        assert!(String::from_utf8_lossy(&log.stdout).contains("Add b"));
    }

    #[test]
    fn push_backup_without_remote_names_the_fix() {
        let dir = tempfile::tempdir().unwrap();
        git_init(dir.path());
        let err = push_backup(dir.path(), None).unwrap_err();
        assert!(err.to_string().contains("--remote"));
    }
}
