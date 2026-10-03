//! A lock file beside the settings file, so the CLI and the daemon do not
//! interleave a read-modify-write. `create_new` is atomic; a lock older than
//! [`STALE_AFTER`] belongs to a process that died and is taken over.

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

const STALE_AFTER: Duration = Duration::from_secs(30);
const GIVE_UP_AFTER: Duration = Duration::from_secs(10);
const RETRY: Duration = Duration::from_millis(5);

/// Held until dropped.
pub(crate) struct FileLock {
    path: PathBuf,
}

impl FileLock {
    /// Take `<path>.lock`, waiting for a live holder.
    pub(crate) fn take(settings: &Path) -> std::io::Result<Self> {
        if let Some(dir) = settings.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let mut name = settings.as_os_str().to_owned();
        name.push(".lock");
        let path = PathBuf::from(name);
        let started = SystemTime::now();
        loop {
            match std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&path)
            {
                Ok(_) => return Ok(Self { path }),
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                    wait_for_holder(&path, started)?;
                }
                Err(error) => return Err(error),
            }
        }
    }
}

/// One step of waiting on a live holder: take over a stale lock, give up
/// after [`GIVE_UP_AFTER`], otherwise sleep and let the caller retry.
fn wait_for_holder(path: &Path, started: SystemTime) -> std::io::Result<()> {
    if is_stale(path) {
        let _ = std::fs::remove_file(path);
    } else if started.elapsed().unwrap_or_default() > GIVE_UP_AFTER {
        return Err(std::io::Error::new(
            std::io::ErrorKind::TimedOut,
            "the plugin settings file is locked",
        ));
    } else {
        std::thread::sleep(RETRY);
    }
    Ok(())
}

fn is_stale(path: &Path) -> bool {
    std::fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|modified| SystemTime::now().duration_since(modified).ok())
        .is_some_and(|age| age > STALE_AFTER)
}

impl Drop for FileLock {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}
