//! Git history for sealed-store entries (`opensesame pass history` / `restore`).
//!
//! History is metadata only: commit sha, subject, timestamp — auto-commits are
//! name-free operation subjects (`seal: add entry`, `seal: edit entry`,
//! `seal: remove entry`, `seal: restore entry`), so neither the secret nor the
//! entry it belongs to is named. History is scoped by path, not by subject. Restore never rewrites history and never winds
//! the anti-rollback counter back: for `.osseal` entries the old plaintext is
//! recovered and re-sealed at a **bumped** revision (writing the literal old
//! blob would be refused by the revision check), committed as a NEW
//! restore commit; for `.gpg`/`.age` entries — which carry no local
//! revision counter — the old ciphertext blob is written back verbatim.

use std::path::{Path, PathBuf};
use std::process::Command;

use opensesame_human_vault::ItemDataKey;

use crate::envelope::open_osseal;
use crate::git::auto_commit;
use crate::path::{confined_write, logical_to_relative};
use crate::{Entry, StoreError, StoreRoot};

/// One commit touching an entry's ciphertext file. Newest first in listings.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HistoryEntry {
    /// Full commit sha.
    pub commit: String,
    /// Commit subject — the operation only, never the entry name.
    pub subject: String,
    /// Committer timestamp, unix seconds.
    pub timestamp: i64,
}

/// The ciphertext file candidates for a logical entry name.
fn candidate_relatives(name: &str) -> Result<Vec<(PathBuf, &'static str)>, StoreError> {
    let rel = logical_to_relative(name)?;
    Ok(["osseal", "gpg", "age"]
        .into_iter()
        .map(|ext| {
            let mut file = rel.clone().into_os_string();
            file.push(".");
            file.push(ext);
            (PathBuf::from(file), ext)
        })
        .collect())
}

fn require_git_repo(root: &Path) -> Result<(), StoreError> {
    if root.join(".git").exists() {
        return Ok(());
    }
    Err(StoreError::Git(format!(
        "{} is not a git repository — no history; run `opensesame pass git init`",
        root.display()
    )))
}

fn git_log(root: &Path, rel: &Path) -> Result<Vec<HistoryEntry>, StoreError> {
    let output = Command::new("git")
        .args(["log", "--format=%H%x09%ct%x09%s", "--"])
        .arg(rel)
        .current_dir(root)
        .output()
        .map_err(|e| StoreError::Git(e.to_string()))?;
    if !output.status.success() {
        // A repository with no commits yet has no history for any entry.
        return Ok(Vec::new());
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let mut entries = Vec::new();
    for line in text.lines() {
        let mut parts = line.splitn(3, '\t');
        let (Some(commit), Some(ts), subject) = (parts.next(), parts.next(), parts.next()) else {
            continue;
        };
        let Ok(timestamp) = ts.parse::<i64>() else {
            continue;
        };
        entries.push(HistoryEntry {
            commit: commit.to_string(),
            subject: subject.unwrap_or("").to_string(),
            timestamp,
        });
    }
    Ok(entries)
}

/// Walk the store's git log for the entry's ciphertext file, newest first.
/// Works for removed entries too — the log outlives the file.
///
/// # Errors
///
/// Returns an error when the store is not a Git repository, the logical name
/// is invalid, Git history cannot be read, or no history exists for the entry.
pub fn entry_history(root: &StoreRoot, name: &str) -> Result<Vec<HistoryEntry>, StoreError> {
    require_git_repo(&root.path)?;
    for (rel, _ext) in candidate_relatives(name)? {
        let entries = git_log(&root.path, &rel)?;
        if !entries.is_empty() {
            return Ok(entries);
        }
    }
    Err(StoreError::NotFound(name.into()))
}

/// A commit-ish we accept for restore: a (possibly abbreviated) hex sha, as
/// printed by [`entry_history`]. Anything else — including strings that could
/// read as git options or rev expressions — is refused before reaching argv.
fn validate_rev(rev: &str) -> Result<(), StoreError> {
    let ok = (4..=64).contains(&rev.len()) && rev.chars().all(|c| c.is_ascii_hexdigit());
    if ok {
        return Ok(());
    }
    Err(StoreError::InvalidPath(format!(
        "revision must be a hex commit sha from `pass history`, got {rev:?}"
    )))
}

/// A ciphertext file as committed at some rev: relative path, extension, bytes.
struct CommittedBlob {
    rel: PathBuf,
    ext: &'static str,
    bytes: Vec<u8>,
}

/// The ciphertext blob for `name` as committed at `rev`, when present there.
fn blob_at(root: &Path, rev: &str, name: &str) -> Result<Option<CommittedBlob>, StoreError> {
    for (rel, ext) in candidate_relatives(name)? {
        let rel_str = rel
            .to_str()
            .ok_or_else(|| StoreError::InvalidPath("non-utf8 path".into()))?
            .replace('\\', "/");
        let output = Command::new("git")
            .args(["show", &format!("{rev}:{rel_str}")])
            .current_dir(root)
            .output()
            .map_err(|e| StoreError::Git(e.to_string()))?;
        if output.status.success() {
            return Ok(Some(CommittedBlob {
                rel,
                ext,
                bytes: output.stdout,
            }));
        }
    }
    Ok(None)
}

/// Restore an entry's content from commit `rev` as a NEW commit.
///
/// Refuses when the entry's file is absent at that rev (or the rev does not
/// exist). Returns the new anti-rollback revision for `.osseal` entries
/// (`None` for `.gpg`/`.age`, which carry no local counter). The counter only
/// ever advances — see the module docs for why the old blob is re-sealed
/// rather than copied for `.osseal`.
///
/// # Errors
///
/// Returns an error when the store or revision is invalid, the entry was absent
/// at that revision, historical ciphertext cannot be read or authenticated, or
/// the restored ciphertext and Git commit cannot be written.
pub fn restore_entry(
    root: &StoreRoot,
    name: &str,
    rev: &str,
    key: &ItemDataKey,
) -> Result<Option<u64>, StoreError> {
    require_git_repo(&root.path)?;
    validate_rev(rev)?;
    let Some(blob) = blob_at(&root.path, rev, name)? else {
        return Err(StoreError::NotFound(format!(
            "{name} is not present at revision {rev}"
        )));
    };
    if blob.ext == "osseal" {
        // Open against the blob's own sealed-in revision (it predates the
        // current counter), then re-seal through the normal write path so
        // the counter bumps and the restored blob is the newest valid one.
        let opened = open_osseal(&blob.bytes, key, name, None)?;
        let text = String::from_utf8(opened.plaintext)
            .map_err(|e| StoreError::Crypto(format!("utf8: {e}")))?;
        let entry = Entry::parse(&text);
        root.write_entry_unchecked(name, &entry, key)?;
        auto_commit(&root.path, crate::store::COMMIT_RESTORE)?;
        return Ok(root.revisions()?.get(name).copied());
    }
    confined_write(&root.path, &blob.rel, &blob.bytes)?;
    auto_commit(&root.path, crate::store::COMMIT_RESTORE)?;
    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{init_store, open_osseal};
    use std::process::Command;

    fn git_init(dir: &Path) {
        assert!(Command::new("git")
            .args(["init"])
            .current_dir(dir)
            .status()
            .unwrap()
            .success());
        let _ = Command::new("git")
            .args(["config", "user.email", "test@example.com"])
            .current_dir(dir)
            .status();
        let _ = Command::new("git")
            .args(["config", "user.name", "Test"])
            .current_dir(dir)
            .status();
    }

    fn entry(secret: &str) -> Entry {
        Entry {
            secret: secret.into(),
            trailer: String::new(),
            otp: None,
        }
    }

    fn seeded() -> (tempfile::TempDir, StoreRoot, ItemDataKey) {
        let dir = tempfile::tempdir().unwrap();
        git_init(dir.path());
        let root = init_store(dir.path(), &[]).unwrap();
        let key = ItemDataKey([9u8; 32]);
        root.insert("Dev/a", &entry("one"), &key).unwrap();
        root.insert_or_replace("Dev/a", &entry("two"), &key)
            .unwrap();
        (dir, root, key)
    }

    #[test]
    fn history_lists_both_commits_newest_first() {
        let (_dir, root, _key) = seeded();
        let log = entry_history(&root, "Dev/a").unwrap();
        assert_eq!(log.len(), 2);
        assert_eq!(log[0].subject, crate::store::COMMIT_EDIT);
        assert_eq!(log[1].subject, crate::store::COMMIT_ADD);
        assert!(log.iter().all(|e| e.timestamp > 0));
        assert!(log.iter().all(|e| e.commit.len() == 40));
    }

    #[test]
    fn history_of_unknown_entry_is_not_found() {
        let (_dir, root, _key) = seeded();
        assert!(matches!(
            entry_history(&root, "Dev/nope"),
            Err(StoreError::NotFound(_))
        ));
    }

    #[test]
    fn restore_brings_back_v1_as_a_new_commit_with_bumped_revision() {
        let (dir, root, key) = seeded();
        let add_sha = entry_history(&root, "Dev/a").unwrap()[1].commit.clone();

        let new_revision = restore_entry(&root, "Dev/a", &add_sha, &key).unwrap();
        // 1 = Add, 2 = Edit, 3 = Restore — the counter only ever advances.
        assert_eq!(new_revision, Some(3));
        assert_eq!(root.show("Dev/a", &key).unwrap().secret, "one");

        let log = entry_history(&root, "Dev/a").unwrap();
        assert_eq!(log.len(), 3);
        assert_eq!(log[0].subject, crate::store::COMMIT_RESTORE);
        assert_eq!(log[2].subject, crate::store::COMMIT_ADD);

        // The restored blob itself is sealed at the bumped revision, so the
        // pre-restore blob is now stale ciphertext.
        let blob = std::fs::read(dir.path().join("Dev/a.osseal")).unwrap();
        assert_eq!(
            open_osseal(&blob, &key, "Dev/a", Some(3)).unwrap().revision,
            3
        );
        assert!(open_osseal(&blob, &key, "Dev/a", Some(2)).is_err());
    }

    #[test]
    fn restore_refuses_a_rev_where_the_file_is_absent() {
        let (_dir, root, key) = seeded();
        // "Dev/other" lands in a later commit; "Dev/a"'s first commit predates it.
        root.insert("Dev/other", &entry("x"), &key).unwrap();
        let a_first = entry_history(&root, "Dev/a").unwrap().pop().unwrap().commit;
        let err = restore_entry(&root, "Dev/other", &a_first, &key).unwrap_err();
        assert!(matches!(err, StoreError::NotFound(_)), "{err}");
    }

    #[test]
    fn restore_refuses_nonexistent_and_malformed_revs() {
        let (_dir, root, key) = seeded();
        // Well-formed hex, but no such commit.
        assert!(restore_entry(&root, "Dev/a", "deadbeefdeadbeef", &key).is_err());
        // Not shas at all — refused before reaching git argv.
        for bad in ["--help", "HEAD~1", "main", "abc", ""] {
            assert!(matches!(
                restore_entry(&root, "Dev/a", bad, &key),
                Err(StoreError::InvalidPath(_))
            ));
        }
    }
}
