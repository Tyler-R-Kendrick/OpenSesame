//! Atomic private trap records. Non-Unix requires a tested locking/confinement adapter.
use crate::StoreError;
use std::path::Path;

pub(super) fn supported() -> Result<(), StoreError> {
    if cfg!(any(unix, windows)) {
        return Ok(());
    }
    Err(StoreError::Other(
        "retired credential storage requires a supported locking and confinement adapter".into(),
    ))
}

pub(super) fn exists(root: &Path) -> Result<bool, StoreError> {
    match std::fs::symlink_metadata(root.join(super::RETIRED_RECORD_FILE)) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error.into()),
    }
}

#[cfg(unix)]
struct Pending {
    directory: std::fs::File,
    name: std::ffi::CString,
}
#[cfg(unix)]
impl Drop for Pending {
    fn drop(&mut self) {
        use std::os::fd::AsRawFd;
        // SAFETY: valid owned directory descriptor and NUL-terminated private name.
        unsafe {
            libc::unlinkat(self.directory.as_raw_fd(), self.name.as_ptr(), 0);
        }
    }
}

#[cfg(unix)]
pub(super) fn write(root: &Path, bytes: &[u8]) -> Result<(), StoreError> {
    write_before_publish(root, bytes, || Ok(()))
}

#[cfg(unix)]
fn write_before_publish(
    root: &Path,
    bytes: &[u8],
    before_publish: impl FnOnce() -> std::io::Result<()>,
) -> Result<(), StoreError> {
    use std::io::Write;
    use std::os::{
        fd::{AsRawFd, FromRawFd},
        unix::fs::OpenOptionsExt,
    };
    let directory = std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(root)?;
    let pending = Pending {
        directory,
        name: std::ffi::CString::new(format!(".retired-pending-{}", uuid::Uuid::new_v4()))
            .expect("UUID contains no NUL"),
    };
    // SAFETY: owned directory and NUL-terminated private component; exclusive creation.
    let fd = unsafe {
        libc::openat(
            pending.directory.as_raw_fd(),
            pending.name.as_ptr(),
            libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            0o600,
        )
    };
    if fd < 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    // SAFETY: successful openat returned a new owned descriptor.
    let mut file = unsafe { std::fs::File::from_raw_fd(fd) };
    file.write_all(bytes)?;
    file.sync_all()?;
    before_publish()?;
    let destination =
        std::ffi::CString::new(super::RETIRED_RECORD_FILE).expect("fixed path contains no NUL");
    // SAFETY: both components and owned directory are valid; rename publishes atomically.
    if unsafe {
        libc::renameat(
            pending.directory.as_raw_fd(),
            pending.name.as_ptr(),
            pending.directory.as_raw_fd(),
            destination.as_ptr(),
        )
    } < 0
    {
        return Err(std::io::Error::last_os_error().into());
    }
    pending.directory.sync_all()?;
    Ok(())
}

#[cfg(windows)]
pub(super) fn write(root: &Path, bytes: &[u8]) -> Result<(), StoreError> {
    supported()?;
    opensesame_human_vault::windows_publish::atomic_write(
        root,
        Path::new(super::RETIRED_RECORD_FILE),
        bytes,
    )
    .map_err(StoreError::Io)
}

#[cfg(not(any(unix, windows)))]
pub(super) fn write(_root: &Path, _bytes: &[u8]) -> Result<(), StoreError> {
    supported()
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    #[test]
    fn process_exit_before_publish_preserves_record() {
        const ENV: &str = "OPENSESAME_TEST_RETIRED_CRASH_ROOT";
        if let Some(root) = std::env::var_os(ENV) {
            let _ = write_before_publish(Path::new(&root), b"interrupted replacement", || {
                std::process::exit(23)
            });
            panic!("fault hook was not reached");
        }
        let dir = tempfile::tempdir().unwrap();
        write(dir.path(), b"last durable records").unwrap();
        let child = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "retired_credentials::persistence::tests::process_exit_before_publish_preserves_record", "--nocapture"])
            .env(ENV, dir.path()).output().unwrap();
        assert_eq!(child.status.code(), Some(23));
        assert_eq!(
            std::fs::read(dir.path().join(super::super::RETIRED_RECORD_FILE)).unwrap(),
            b"last durable records"
        );
        write(dir.path(), b"complete subsequent records").unwrap();
        assert_eq!(
            std::fs::read(dir.path().join(super::super::RETIRED_RECORD_FILE)).unwrap(),
            b"complete subsequent records"
        );
    }
    #[test]
    fn failed_publish_preserves_last_complete_records_and_cleans_pending() {
        let dir = tempfile::tempdir().unwrap();
        write(dir.path(), b"previous complete records").unwrap();
        let result = write_before_publish(dir.path(), b"replacement", || {
            Err(std::io::Error::other("injected crash before rename"))
        });
        assert!(result.is_err());
        assert_eq!(
            std::fs::read(dir.path().join(super::super::RETIRED_RECORD_FILE)).unwrap(),
            b"previous complete records"
        );
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);
        write(dir.path(), b"new complete records").unwrap();
        assert_eq!(
            std::fs::read(dir.path().join(super::super::RETIRED_RECORD_FILE)).unwrap(),
            b"new complete records"
        );
    }
}
