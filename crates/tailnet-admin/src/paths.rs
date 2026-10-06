//! Where the tailnet admin state lives, and how a file in it is written: a
//! `0700` directory of `0600` files, each replaced whole by a rename so a
//! crash leaves the previous version intact.
//!
//! ```text
//! <dir>/tailnet-admin.json         which tailnet, which kind of credential
//! <dir>/tailnet-admin.secret       scoped credential envelope
//! <dir>/tailnet-admin.key          private local bootstrap root
//! <dir>/tailnet-pairings.json      code and bearer digests, origin, role
//! <dir>/tailnet-admin-audit.jsonl  one line per change, no values
//! ```

use std::path::{Path, PathBuf};

use crate::AdminError;

/// Names the directory instead of `<config dir>/tailnet`, as
/// `OPENSESAME_VAULT_DRIVE_DIR` does for the drive. Within the user boundary:
/// a same-user process could redirect `HOME` to the same effect.
pub const DIR_ENV: &str = "OPENSESAME_TAILNET_ADMIN_DIR";

/// The directory from [`DIR_ENV`], else the user's config directory.
///
/// # Errors
///
/// `NoDirectory` when the platform has no home or config directory.
pub fn admin_dir_from(env: impl Fn(&str) -> Option<String>) -> Result<PathBuf, AdminError> {
    if let Some(dir) = env(DIR_ENV).filter(|v| !v.trim().is_empty()) {
        return Ok(PathBuf::from(dir));
    }
    let dirs = directories::ProjectDirs::from("dev", "OpenSesame", "opensesame")
        .ok_or(AdminError::NoDirectory)?;
    Ok(dirs.config_dir().join("tailnet"))
}

/// [`admin_dir_from`] over this process's environment.
///
/// # Errors
///
/// `NoDirectory` when the platform has no home or config directory.
pub fn default_admin_dir() -> Result<PathBuf, AdminError> {
    admin_dir_from(|key| std::env::var(key).ok())
}

/// Create `dir` (and its parents) and hold it to `0700`.
pub(crate) fn ensure_private_dir(dir: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

/// Replace `path` with `bytes`: written to a temp file of our own at `0600`,
/// then renamed into place.
pub(crate) fn write_private(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    if let Some(dir) = path.parent() {
        ensure_private_dir(dir)?;
    }
    let unique = format!(
        "{}.{}.tmp",
        std::process::id(),
        NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    );
    let tmp = path.with_extension(unique);
    let written = create_private(&tmp)
        .and_then(|mut file| std::io::Write::write_all(&mut file, bytes))
        .and_then(|()| std::fs::rename(&tmp, path));
    if written.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    written
}

/// Open `path` for writing at `0600`, truncating what was there.
pub(crate) fn create_private(path: &Path) -> std::io::Result<std::fs::File> {
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    opts.open(path)
}

/// How long a writer waits for another to finish before giving up.
const LOCK_WAIT: std::time::Duration = std::time::Duration::from_secs(3);
/// A lock older than this was left by a process that died holding it.
const LOCK_STALE: std::time::Duration = std::time::Duration::from_secs(30);

/// A lock on `path` shared by every process that writes it — the daemon and
/// the CLI beside it — so one's load-modify-save never undoes another's. It
/// is a sibling file created exclusively; dropping the guard removes it.
pub(crate) struct FileLock {
    path: PathBuf,
}

impl FileLock {
    pub(crate) fn acquire(path: &Path) -> std::io::Result<Self> {
        if let Some(dir) = path.parent() {
            ensure_private_dir(dir)?;
        }
        let lock = path.with_extension("lock");
        let started = std::time::Instant::now();
        loop {
            match create_exclusive(&lock) {
                Ok(()) => return Ok(Self { path: lock }),
                Err(error) if error.kind() != std::io::ErrorKind::AlreadyExists => {
                    return Err(error)
                }
                Err(_) if is_stale(&lock) => {
                    let _ = std::fs::remove_file(&lock);
                }
                Err(_) if started.elapsed() > LOCK_WAIT => {
                    return Err(std::io::Error::new(
                        std::io::ErrorKind::WouldBlock,
                        "another writer holds the tailnet state",
                    ));
                }
                Err(_) => std::thread::sleep(std::time::Duration::from_millis(10)),
            }
        }
    }
}

/// Create `path` at `0600`, failing if it already exists.
fn create_exclusive(path: &Path) -> std::io::Result<()> {
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    opts.open(path).map(drop)
}

/// A lock left by a process that died holding it.
fn is_stale(lock: &Path) -> bool {
    std::fs::metadata(lock)
        .and_then(|meta| meta.modified())
        .ok()
        .and_then(|at| at.elapsed().ok())
        .is_some_and(|age| age > LOCK_STALE)
}

impl Drop for FileLock {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

/// Read `path`, or `None` when it does not exist.
pub(crate) fn read_optional(path: &Path) -> std::io::Result<Option<Vec<u8>>> {
    match std::fs::read(path) {
        Ok(bytes) => Ok(Some(bytes)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_environment_names_the_directory() {
        let dir = admin_dir_from(|key| (key == DIR_ENV).then(|| "/srv/ts".to_string())).unwrap();
        assert_eq!(dir, PathBuf::from("/srv/ts"));
        let blank = admin_dir_from(|key| (key == DIR_ENV).then(|| "  ".to_string()));
        assert!(blank.map_or(true, |d| d.ends_with("tailnet")));
    }

    #[cfg(unix)]
    #[test]
    fn files_are_private_and_replaced_whole() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("state");
        let path = dir.join("f.json");
        write_private(&path, b"one").unwrap();
        write_private(&path, b"two").unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"two");
        let mode = |p: &Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(&path), 0o600);
        assert_eq!(mode(&dir), 0o700);
        let leftovers = std::fs::read_dir(&dir).unwrap().count();
        assert_eq!(leftovers, 1, "no temp file left behind");
        assert_eq!(read_optional(&dir.join("missing")).unwrap(), None);
    }

    #[test]
    fn a_lock_is_held_once_and_released_on_drop() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("state.json");
        let held = FileLock::acquire(&path).unwrap();
        assert!(create_exclusive(&path.with_extension("lock")).is_err());
        drop(held);
        assert!(!path.with_extension("lock").exists());
        drop(FileLock::acquire(&path).unwrap());
    }
}
