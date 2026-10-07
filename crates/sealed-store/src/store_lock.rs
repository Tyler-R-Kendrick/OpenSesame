//! Store-level write lock shared by every writer and a root rotation.
//!
//! A root rotation re-encrypts everything sealed under the vault root and then
//! swaps the key file. A write that lands in the middle — or one that seals
//! with a key unlocked before the rotation committed — would leave content
//! sealed under the revoked root. So:
//!
//! - rotation holds an **exclusive** lock on `.opensesame-lock` for its whole
//!   run, and refuses to start while any writer holds it;
//! - every ordinary write holds a **shared** lock for its own duration, refuses
//!   (never blocks) while a rotation holds the exclusive one, and refuses while
//!   `.opensesame-rotation/` exists (a rotation is running or was interrupted);
//! - a write that seals under the root first proves its key is the store's
//!   current root (the key file's manifest MAC), so a key unlocked before a
//!   rotation cannot write under the old root after it.
//!
//! The lock is `flock(2)` on Unix and `LockFileEx` on Windows; process exit
//! releases either lock. Windows also retains confined ancestor handles.

#[cfg(not(windows))]
use std::fs::File;
use std::path::Path;

use opensesame_human_vault::root_protection::{
    load_key_file, verify_manifest_auth, KeyFileContents, KEY_FILE_NAME,
};
use opensesame_human_vault::{ItemDataKey, VaultRootKey};

use crate::rotation::ROTATION_STAGING_DIR;
use crate::StoreError;

/// Lock file, relative to the store root. Never committed (see `auto_commit`).
pub(crate) const STORE_LOCK_FILE: &str = ".opensesame-lock";

/// Top-level names no entry or attachment may live under: rotation does not
/// walk them for content, so nothing sealed may be written there. Compared
/// ASCII-case-insensitively: on a case-folding filesystem `.GIT/token` lands
/// in `.git/`.
const RESERVED_TOP_LEVEL: [&str; 4] = [
    ".git",
    ".attachments",
    ROTATION_STAGING_DIR,
    STORE_LOCK_FILE,
];

/// A held store lock; released when dropped (or when the process exits).
#[cfg(windows)]
type PlatformLock = opensesame_human_vault::windows_io::WindowsLock;
#[cfg(not(windows))]
type PlatformLock = File;
pub(crate) struct StoreLock {
    _file: PlatformLock,
}

#[cfg(unix)]
impl Drop for StoreLock {
    fn drop(&mut self) {
        use std::os::fd::AsRawFd;

        // A concurrent fork can retain this open-file description until exec,
        // even with O_CLOEXEC. Release at the guard's lifetime boundary rather
        // than waiting for the last inherited descriptor to close.
        // SAFETY: the owned file descriptor remains valid throughout drop.
        let _ = unsafe { libc::flock(self._file.as_raw_fd(), libc::LOCK_UN) };
    }
}

impl StoreLock {
    /// The rotation lock: refused while any writer or another rotation holds it.
    pub(crate) fn exclusive(root: &Path) -> Result<Self, StoreError> {
        let file = held_lock(root, true).map_err(|busy| {
            busy.unwrap_or_else(|| {
                StoreError::Other(
                    "the store is busy: another write or rotation is in progress; retry once \
                     it finishes"
                        .into(),
                )
            })
        })?;
        Ok(Self { _file: file })
    }

    /// An ordinary write: refused while a rotation runs or left its staging.
    pub(crate) fn shared(root: &Path) -> Result<Self, StoreError> {
        refuse_staging(root)?;
        let file =
            held_lock(root, false).map_err(|busy| busy.unwrap_or_else(rotation_in_progress))?;
        let lock = Self { _file: file };
        Self::finish_shared(root, lock)
    }

    fn finish_shared(root: &Path, held: Self) -> Result<Self, StoreError> {
        // A rotation may have created its staging directory between the first
        // check and the lock; with the lock held, look again.
        refuse_staging(root)?;
        Ok(held)
    }

    /// A key-file edit (add, remove or rewrap a protector): exclusive, so two
    /// edits cannot interleave their read-modify-write of the key file (an
    /// `add` racing a `remove` would write the removed protector back), and
    /// refused, like any write, while a rotation's staging exists.
    pub(crate) fn key_file_edit(root: &Path) -> Result<Self, StoreError> {
        refuse_staging(root)?;
        let lock = Self::exclusive(root)?;
        refuse_staging(root)?;
        Ok(lock)
    }

    /// A write that seals `name` under `key`: [`Self::shared`], plus a refusal
    /// of reserved locations and of a key that is not the store's current root.
    pub(crate) fn for_sealing(
        root: &Path,
        name: &str,
        key: &ItemDataKey,
    ) -> Result<Self, StoreError> {
        refuse_reserved_name(name)?;
        let lock = Self::shared(root)?;
        ensure_current_root(root, key)?;
        Ok(lock)
    }
}

fn rotation_in_progress() -> StoreError {
    StoreError::Other(
        "a root rotation is in progress; nothing may be written until it finishes".into(),
    )
}

fn refuse_staging(root: &Path) -> Result<(), StoreError> {
    if std::fs::symlink_metadata(root.join(ROTATION_STAGING_DIR)).is_ok() {
        return Err(StoreError::Other(format!(
            "{ROTATION_STAGING_DIR} exists: a root rotation is running or was interrupted; \
             nothing may be written until it finishes or is resolved"
        )));
    }
    Ok(())
}

fn refuse_reserved_name(name: &str) -> Result<(), StoreError> {
    // The first path component as the platform splits it (so a backslash counts on
    // Windows), not merely up to the first `/`.
    let first = Path::new(name.trim())
        .components()
        .next()
        .map(|component| component.as_os_str().to_string_lossy().into_owned())
        .unwrap_or_default();
    if RESERVED_TOP_LEVEL
        .iter()
        .any(|reserved| first.eq_ignore_ascii_case(reserved))
    {
        return Err(StoreError::InvalidPath(format!(
            "{first} is reserved for the store's own state"
        )));
    }
    Ok(())
}

/// Refuse a key the current key file does not authenticate.
///
/// A versioned manifest carries a MAC derived from its root, so a stale root
/// fails here. A legacy wrapper (never rotated) or a keyless store has nothing
/// to check against and passes, exactly as before.
fn ensure_current_root(root: &Path, key: &ItemDataKey) -> Result<(), StoreError> {
    if !root.join(KEY_FILE_NAME).exists() {
        return Ok(());
    }
    let KeyFileContents::Manifest(manifest) = load_key_file(root)? else {
        return Ok(());
    };
    verify_manifest_auth(&VaultRootKey(key.0), &manifest).map_err(|_| {
        StoreError::Crypto(
            "this key is not the store's current root (it was rotated); unlock again".into(),
        )
    })
}

#[cfg(windows)]
fn held_lock(root: &Path, exclusive: bool) -> Result<PlatformLock, Option<StoreError>> {
    opensesame_human_vault::windows_io::lock(root, Path::new(STORE_LOCK_FILE), exclusive).map_err(
        |error| {
            if error.kind() == std::io::ErrorKind::WouldBlock {
                None
            } else {
                Some(StoreError::Io(error))
            }
        },
    )
}
#[cfg(not(windows))]
fn held_lock(root: &Path, exclusive: bool) -> Result<PlatformLock, Option<StoreError>> {
    let file = open_lock_file(root).map_err(Some)?;
    acquire(&file, exclusive)?;
    Ok(file)
}

#[cfg(unix)]
fn open_lock_file(root: &Path) -> Result<File, StoreError> {
    use std::os::unix::fs::OpenOptionsExt;

    if std::fs::symlink_metadata(root)?.file_type().is_symlink() {
        return Err(StoreError::InvalidPath(
            "store root may not be a symlink".into(),
        ));
    }
    Ok(std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(root.join(STORE_LOCK_FILE))?)
}

/// `Err(None)` means the lock is held elsewhere; `Err(Some(_))` is a failure.
#[cfg(unix)]
fn acquire(file: &File, exclusive: bool) -> Result<(), Option<StoreError>> {
    use std::os::fd::AsRawFd;

    let mode = if exclusive {
        libc::LOCK_EX
    } else {
        libc::LOCK_SH
    };
    // SAFETY: `file` owns a valid descriptor for the duration of the call.
    if unsafe { libc::flock(file.as_raw_fd(), mode | libc::LOCK_NB) } == 0 {
        return Ok(());
    }
    let error = std::io::Error::last_os_error();
    if error.raw_os_error() == Some(libc::EWOULDBLOCK) {
        return Err(None);
    }
    Err(Some(StoreError::Io(error)))
}

#[cfg(not(any(unix, windows)))]
fn open_lock_file(root: &Path) -> Result<File, StoreError> {
    Ok(std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(root.join(STORE_LOCK_FILE))?)
}

/// Without `flock`, only the staging-directory refusal protects writers.
#[cfg(not(any(unix, windows)))]
fn acquire(_file: &File, _exclusive: bool) -> Result<(), Option<StoreError>> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[test]
    fn failed_second_staging_check_releases_the_retained_descriptor_lock() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        let held = StoreLock {
            _file: held_lock(root, false).unwrap(),
        };
        let retained = held._file.try_clone().unwrap();
        std::fs::create_dir(root.join(ROTATION_STAGING_DIR)).unwrap();
        let result = StoreLock::finish_shared(root, held);
        assert!(matches!(result, Err(StoreError::Other(message)) if message.contains("exists")));
        assert!(StoreLock::key_file_edit(root).is_err());
        std::fs::remove_dir(root.join(ROTATION_STAGING_DIR)).unwrap();
        let edit = StoreLock::key_file_edit(root).unwrap();
        assert!(StoreLock::shared(root).is_err());
        drop(retained);
        assert!(StoreLock::shared(root).is_err());
        drop(edit);
        assert!(StoreLock::shared(root).is_ok());
    }

    #[cfg(unix)]
    #[test]
    fn exclusive_guard_releases_despite_a_retained_duplicate_descriptor() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        let guard = StoreLock::key_file_edit(root).unwrap();
        // try_clone duplicates the same open-file description inherited by fork.
        let retained = guard._file.try_clone().unwrap();
        assert!(StoreLock::key_file_edit(root).is_err());
        assert!(StoreLock::shared(root).is_err());
        drop(guard);
        let next = StoreLock::key_file_edit(root).unwrap();
        assert!(StoreLock::key_file_edit(root).is_err());
        drop(retained);
        // Closing the old descriptor must not release the independent new edit.
        assert!(StoreLock::shared(root).is_err());
        drop(next);
        assert!(StoreLock::shared(root).is_ok());
    }

    #[cfg(unix)]
    #[test]
    fn releasing_one_shared_guard_preserves_another_live_writer() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        let first = StoreLock::shared(root).unwrap();
        let retained = first._file.try_clone().unwrap();
        let second = StoreLock::shared(root).unwrap();
        drop(first);
        assert!(StoreLock::key_file_edit(root).is_err());
        drop(second);
        // The completed first writer's duplicate must not prolong its lock.
        let edit = StoreLock::key_file_edit(root).unwrap();
        assert!(StoreLock::shared(root).is_err());
        drop(retained);
        assert!(StoreLock::shared(root).is_err());
        drop(edit);
        assert!(StoreLock::shared(root).is_ok());
    }

    #[test]
    fn reserved_top_level_names_are_refused_in_any_ascii_case() {
        let staging = format!("{}/x", ROTATION_STAGING_DIR.to_ascii_uppercase());
        for name in [
            ".git/x",
            ".GIT/token",
            ".Git",
            ".Attachments/x",
            ".ATTACHMENTS/objects/ab",
            staging.as_str(),
            ".OpenSesame-Lock/x",
            "  .GIT/padded",
        ] {
            assert!(refuse_reserved_name(name).is_err(), "{name}");
        }
        for name in ["Dev/.git", ".gitx/token", "Dev/.GIT/x", ".npmrc", "Dev/.w2"] {
            assert!(refuse_reserved_name(name).is_ok(), "{name}");
        }
    }
}
