//! Private held-handle OS primitives; no root admission or caller permission flags.
#[cfg(unix)]
use super::STORE_LOCK_FILE;
use crate::StoreError;
use std::fs::File;
use std::path::Path;

#[cfg(unix)]
pub(super) fn open_lock_file(root: &Path) -> Result<File, StoreError> {
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
pub(super) fn acquire(file: &File, exclusive: bool) -> Result<(), Option<StoreError>> {
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

// Preserve the historical Windows path opener for this OS-lock correction.
// This is not a pinned ancestor chain or an owner-private DACL check.
#[cfg(windows)]
pub(super) fn open_lock_file(root: &Path) -> Result<File, StoreError> {
    Ok(std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(root.join(super::STORE_LOCK_FILE))?)
}

/// `file` must be a live synchronous handle held throughout the critical section.
/// Busy is exclusively the actual kernel's lock-violation result.
#[cfg(windows)]
pub(super) fn acquire(file: &File, exclusive: bool) -> Result<(), Option<StoreError>> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Foundation::ERROR_LOCK_VIOLATION;
    use windows_sys::Win32::Storage::FileSystem::{
        LockFileEx, LOCKFILE_EXCLUSIVE_LOCK, LOCKFILE_FAIL_IMMEDIATELY,
    };
    let mut flags = LOCKFILE_FAIL_IMMEDIATELY;
    if exclusive {
        flags |= LOCKFILE_EXCLUSIVE_LOCK;
    }
    let mut overlapped = windows_sys::Win32::System::IO::OVERLAPPED::default();
    // SAFETY: File owns a valid synchronous handle; OVERLAPPED is initialized at
    // offset zero and remains live for this nonblocking call. All locks use byte [0,1).
    if unsafe { LockFileEx(file.as_raw_handle(), flags, 0, 1, 0, &mut overlapped) } != 0 {
        return Ok(());
    }
    let error = std::io::Error::last_os_error();
    if error
        .raw_os_error()
        .is_some_and(|code| u32::try_from(code) == Ok(ERROR_LOCK_VIOLATION))
    {
        return Err(None);
    }
    Err(Some(StoreError::Io(error)))
}

#[cfg(windows)]
pub(super) fn release(file: &File) -> std::io::Result<()> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::UnlockFileEx;
    let mut overlapped = windows_sys::Win32::System::IO::OVERLAPPED::default();
    // SAFETY: the same held synchronous File and offset/length identify its lock.
    if unsafe { UnlockFileEx(file.as_raw_handle(), 0, 1, 0, &mut overlapped) } == 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(())
}

#[cfg(not(any(unix, windows)))]
pub(super) fn open_lock_file(_root: &Path) -> Result<File, StoreError> {
    Err(unsupported())
}
#[cfg(not(any(unix, windows)))]
pub(super) fn acquire(_file: &File, _exclusive: bool) -> Result<(), Option<StoreError>> {
    Err(Some(unsupported()))
}
#[cfg(not(any(unix, windows)))]
fn unsupported() -> StoreError {
    StoreError::Io(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "native store locking is unsupported on this platform",
    ))
}

#[cfg(all(test, any(unix, windows)))]
#[path = "store_lock_platform_tests.rs"]
mod tests;
