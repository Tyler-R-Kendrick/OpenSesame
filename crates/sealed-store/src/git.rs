use std::path::Path;
use std::process::Command;

use opensesame_trusted_exec::Lookup;

use crate::git_exec::{git, git_in};
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

/// Initialize `root` as a Git repository when necessary and configure its
/// repository-local commit identity.
///
/// # Errors
///
/// Returns an error when Git cannot be launched or repository initialization
/// fails.
pub fn ensure_git_repo(root: &Path) -> Result<(), StoreError> {
    if !root.join(".git").exists() {
        let status = git()?
            .args(["init"])
            .current_dir(root)
            .status()
            .map_err(|e| StoreError::Git(e.to_string()))?;
        if !status.success() {
            return Err(StoreError::Git("git init failed".into()));
        }
    }
    // Local identity for the store repo only (not the OpenSesame project).
    let _ = git()?
        .args(["config", "user.email", "opensesame-store@localhost"])
        .current_dir(root)
        .status();
    let _ = git()?
        .args(["config", "user.name", "OpenSesame Store"])
        .current_dir(root)
        .status();
    Ok(())
}

/// Commit only ciphertext and store configuration when `root` is a git repository.
///
/// # Errors
///
/// Returns an error when Git cannot enumerate or stage the allowed files.
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
    let listed = git()?
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
            let encrypted_file = Path::new(path)
                .extension()
                .and_then(|extension| extension.to_str())
                .is_some_and(|extension| {
                    matches!(extension, "osseal" | "gpg" | "age" | "osattach" | "oschunk")
                });
            matches!(
                *path,
                ".opensesame-key" | ".opensesame-recipients" | ".gpg-id" | ".age-recipients"
            ) || encrypted_file
        })
        .collect();
    if paths.is_empty() {
        return Ok(());
    }
    for batch in paths.chunks(ADD_BATCH) {
        let add = git()?
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
    let status = git()?
        .args(["diff", "--cached", "--quiet"])
        .current_dir(root)
        .status()
        .map_err(|e| StoreError::Git(e.to_string()))?;
    if status.success() {
        // exit 0 => no diff
        return Ok(());
    }
    let commit = git()?
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

/// Run an explicitly supplied Git command in the sealed-store repository.
///
/// # Errors
///
/// Returns an error when Git cannot be launched.
pub fn git_passthrough(root: &Path, args: &[String]) -> Result<i32, StoreError> {
    let status = git()?
        .args(args)
        .current_dir(root)
        .status()
        .map_err(|e| StoreError::Git(e.to_string()))?;
    Ok(status.code().unwrap_or(1))
}

/// The configured backup remote, when one exists.
#[must_use]
pub fn remote_url(root: &Path) -> Option<String> {
    let output = git()
        .ok()?
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
///
/// # Errors
///
/// Returns an error when repository initialization or remote configuration
/// fails.
pub fn set_remote(root: &Path, url: &str) -> Result<(), StoreError> {
    ensure_git_repo(root)?;
    let sub = if remote_url(root).is_some() {
        "set-url"
    } else {
        "add"
    };
    let status = git()?
        .args(["remote", sub, REMOTE, url])
        .current_dir(root)
        .status()
        .map_err(|e| StoreError::Git(e.to_string()))?;
    if !status.success() {
        return Err(StoreError::Git(format!("git remote {sub} failed")));
    }
    Ok(())
}

/// Whether automatic backup pushes are enabled for this repository.
#[must_use]
pub fn auto_push_enabled(root: &Path) -> bool {
    let Ok(mut command) = git() else {
        return false;
    };
    command
        .args(["config", "--get", AUTOPUSH_KEY])
        .current_dir(root)
        .output()
        .map(|o| o.status.success() && String::from_utf8_lossy(&o.stdout).trim() == "true")
        .unwrap_or(false)
}

/// Enable or disable automatic backup pushes for this repository.
///
/// # Errors
///
/// Returns an error when Git cannot update the repository-local setting.
pub fn set_auto_push(root: &Path, enabled: bool) -> Result<(), StoreError> {
    let status = git()?
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
///
/// # Errors
///
/// Returns an error when no remote is configured, Git cannot be launched, or
/// the push fails.
pub fn push_backup(root: &Path, token: Option<&str>) -> Result<(), StoreError> {
    if remote_url(root).is_none() {
        return Err(StoreError::Git(
            "no backup remote configured; run `opensesame pass backup --remote <url>`".into(),
        ));
    }
    let mut cmd = authenticated_git_in(&Lookup::capture(), token)?;
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

/// `git`, and with a `token` the one credential helper that answers with it.
/// The token travels in [`GIT_TOKEN_ENV`] in the child's environment only.
fn authenticated_git_in(lookup: &Lookup, token: Option<&str>) -> Result<Command, StoreError> {
    let mut cmd = git_in(lookup)?;
    if let Some(token) = token {
        let helper = format!(
            "!f() {{ echo username=x-access-token; echo \"password=${GIT_TOKEN_ENV}\"; }}; f"
        );
        // An empty value first empties git's list of helpers: git asks every
        // helper it has, the person's own first, and once the push works tells
        // each to remember what it was given, so `store` would write the token
        // to ~/.git-credentials in plaintext.
        cmd.env(GIT_TOKEN_ENV, token)
            .arg("-c")
            .arg("credential.helper=")
            .arg("-c")
            .arg(format!("credential.helper={helper}"));
    }
    Ok(cmd)
}

#[cfg(test)]
mod tests;
