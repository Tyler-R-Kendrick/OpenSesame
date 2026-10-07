//! Fixed-name detector storage: private, no-follow, bounded and atomic publication.
use crate::StoreError;
use std::path::Path;
#[derive(Clone, Copy)]
pub(super) enum Record {
    Key,
    State,
    Validator,
}
impl Record {
    #[cfg(any(unix, windows))]
    fn name(self) -> &'static str {
        match self {
            Self::Key => ".opensesame-observation-device-key.v1",
            Self::State => ".opensesame-credential-canaries.v1",
            Self::Validator => ".opensesame-installed-canary-validator.v1",
        }
    }
}
#[cfg(unix)]
pub(super) fn require_private_directory(root: &Path) -> Result<(), StoreError> {
    use std::os::unix::fs::MetadataExt;
    let metadata = unix::directory(root)?.metadata()?;
    if metadata.mode() & 0o077 != 0 {
        return Err(StoreError::Other(
            "installed validator requires an owner-private directory".into(),
        ));
    }
    Ok(())
}
#[cfg(windows)]
pub(super) fn require_private_directory(root: &Path) -> Result<(), StoreError> {
    supported()?;
    // Retained parent pins validate owner-only ACLs and local NTFS without opening a final node.
    let _pinned = opensesame_human_vault::windows_io::PinnedParent::open(
        root,
        Path::new(Record::Validator.name()),
        false,
    )?;
    Ok(())
}
#[cfg(not(any(unix, windows)))]
pub(super) fn require_private_directory(_root: &Path) -> Result<(), StoreError> {
    supported()
}
pub(super) fn supported() -> Result<(), StoreError> {
    if cfg!(any(unix, windows)) {
        return Ok(());
    }
    Err(StoreError::Other(
        "credential observation persistence requires the tested platform confinement adapter"
            .into(),
    ))
}
#[cfg(unix)]
mod unix {
    use super::*;
    use std::{
        ffi::CString,
        fs::{File, OpenOptions},
        io::{Read, Write},
        os::{
            fd::{AsRawFd, FromRawFd},
            unix::fs::{MetadataExt, OpenOptionsExt},
        },
    };
    fn invalid() -> StoreError {
        StoreError::Other("private credential observation storage is unavailable".into())
    }
    pub(super) fn directory(root: &Path) -> Result<File, StoreError> {
        let file = OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
            .open(root)?;
        let metadata = file.metadata()?;
        // SAFETY: geteuid has no arguments or lifetime requirements.
        if metadata.uid() != unsafe { libc::geteuid() } || metadata.mode() & 0o022 != 0 {
            return Err(invalid());
        }
        Ok(file)
    }
    fn component(record: Record) -> CString {
        CString::new(record.name()).expect("fixed private component contains no NUL")
    }
    fn open(dir: &File, record: Record) -> Result<Option<File>, StoreError> {
        let name = component(record);
        // SAFETY: owned directory descriptor and fixed NUL-terminated component.
        let fd = unsafe {
            libc::openat(
                dir.as_raw_fd(),
                name.as_ptr(),
                libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC,
            )
        };
        if fd < 0 {
            let error = std::io::Error::last_os_error();
            if error.kind() == std::io::ErrorKind::NotFound {
                return Ok(None);
            }
            return Err(error.into());
        }
        // SAFETY: successful openat returns a fresh owned descriptor.
        let file = unsafe { File::from_raw_fd(fd) };
        let metadata = file.metadata()?;
        // SAFETY: geteuid has no arguments or lifetime requirements.
        if !metadata.is_file()
            || metadata.nlink() != 1
            || metadata.uid() != unsafe { libc::geteuid() }
            || metadata.mode() & 0o777 != 0o600
        {
            return Err(invalid());
        }
        Ok(Some(file))
    }
    pub(in crate::credential_canaries) fn read(
        root: &Path,
        record: Record,
        max: usize,
    ) -> Result<Option<Vec<u8>>, StoreError> {
        let dir = directory(root)?;
        let Some(file) = open(&dir, record)? else {
            return Ok(None);
        };
        let mut bytes = Vec::new();
        file.take(u64::try_from(max).unwrap_or(u64::MAX).saturating_add(1))
            .read_to_end(&mut bytes)?;
        if bytes.len() > max {
            return Err(invalid());
        }
        Ok(Some(bytes))
    }
    struct Pending {
        directory: File,
        name: CString,
    }
    impl Drop for Pending {
        fn drop(&mut self) {
            // SAFETY: owned directory and private temporary component remain valid.
            unsafe {
                libc::unlinkat(self.directory.as_raw_fd(), self.name.as_ptr(), 0);
            }
        }
    }
    pub(in crate::credential_canaries) fn write(
        root: &Path,
        record: Record,
        bytes: &[u8],
    ) -> Result<(), StoreError> {
        write_before_publish(root, record, bytes, || Ok(()))
    }
    pub(in crate::credential_canaries) fn remove(
        root: &Path,
        record: Record,
    ) -> Result<(), StoreError> {
        let dir = directory(root)?;
        let Some(_file) = open(&dir, record)? else {
            return Ok(());
        };
        let name = component(record);
        // SAFETY: fixed component within an owned no-follow pinned directory; unlink never follows it.
        if unsafe { libc::unlinkat(dir.as_raw_fd(), name.as_ptr(), 0) } < 0 {
            return Err(std::io::Error::last_os_error().into());
        }
        dir.sync_all()?;
        Ok(())
    }
    pub(super) fn write_before_publish(
        root: &Path,
        record: Record,
        bytes: &[u8],
        before: impl FnOnce() -> std::io::Result<()>,
    ) -> Result<(), StoreError> {
        let dir = directory(root)?;
        let _existing = open(&dir, record)?;
        let pending = Pending {
            directory: dir,
            name: CString::new(format!(".observation-pending-{}", uuid::Uuid::new_v4()))
                .expect("UUID contains no NUL"),
        };
        // SAFETY: pinned directory and exclusive no-follow private creation.
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
        // SAFETY: successful openat returns a fresh owned descriptor.
        let mut file = unsafe { File::from_raw_fd(fd) };
        file.write_all(bytes)?;
        file.sync_all()?;
        before()?;
        let destination = component(record);
        // SAFETY: both names are fixed/private within the same pinned directory.
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
}
#[cfg(unix)]
pub(super) use unix::{read, remove, write};
#[cfg(windows)]
pub(super) fn read(root: &Path, record: Record, max: usize) -> Result<Option<Vec<u8>>, StoreError> {
    supported()?;
    require_private_directory(root)?;
    match opensesame_human_vault::windows_io::read_bounded(
        root,
        Path::new(record.name()),
        if matches!(record, Record::Key) {
            opensesame_human_vault::windows_publish::detector_key::MAX_SEALED_KEY_BYTES
        } else {
            max
        },
    ) {
        Ok(bytes) => {
            if matches!(record, Record::Key) {
                let key = opensesame_human_vault::windows_publish::detector_key::open(
                    &super::storage::identity(root)?,
                    &bytes,
                )?;
                Ok(Some(key[..].to_vec()))
            } else {
                Ok(Some(bytes))
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.into()),
    }
}
#[cfg(windows)]
pub(super) fn write(root: &Path, record: Record, bytes: &[u8]) -> Result<(), StoreError> {
    supported()?;
    let protected;
    let bytes = if matches!(record, Record::Key) {
        protected = opensesame_human_vault::windows_publish::detector_key::seal(
            &super::storage::identity(root)?,
            bytes,
        )?;
        protected.as_slice()
    } else {
        bytes
    };
    opensesame_human_vault::windows_publish::atomic_write(root, Path::new(record.name()), bytes)?;
    Ok(())
}
#[cfg(windows)]
pub(super) fn remove(root: &Path, record: Record) -> Result<(), StoreError> {
    supported()?;
    require_private_directory(root)?;
    match opensesame_human_vault::windows_io::remove(root, Path::new(record.name())) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}
#[cfg(not(any(unix, windows)))]
pub(super) fn read(
    _root: &Path,
    _record: Record,
    _max: usize,
) -> Result<Option<Vec<u8>>, StoreError> {
    supported()?;
    Ok(None)
}
#[cfg(not(any(unix, windows)))]
pub(super) fn write(_root: &Path, _record: Record, _bytes: &[u8]) -> Result<(), StoreError> {
    supported()
}
#[cfg(not(any(unix, windows)))]
pub(super) fn remove(_root: &Path, _record: Record) -> Result<(), StoreError> {
    supported()
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::{symlink, PermissionsExt};
    #[test]
    fn private_detector_files_refuse_symlinks_hardlinks_modes_and_oversize() {
        let dir = tempfile::tempdir().unwrap();
        let outside = tempfile::NamedTempFile::new().unwrap();
        symlink(outside.path(), dir.path().join(Record::Key.name())).unwrap();
        assert!(read(dir.path(), Record::Key, 32).is_err());
        assert!(write(dir.path(), Record::Key, b"key").is_err());
        std::fs::remove_file(dir.path().join(Record::Key.name())).unwrap();
        write(dir.path(), Record::Key, b"1234").unwrap();
        assert!(read(dir.path(), Record::Key, 3).is_err());
        std::fs::hard_link(
            dir.path().join(Record::Key.name()),
            dir.path().join("alias"),
        )
        .unwrap();
        assert!(read(dir.path(), Record::Key, 32).is_err());
        assert!(write(dir.path(), Record::Key, b"new").is_err());
        std::fs::remove_file(dir.path().join("alias")).unwrap();
        std::fs::set_permissions(
            dir.path().join(Record::Key.name()),
            std::fs::Permissions::from_mode(0o644),
        )
        .unwrap();
        assert!(read(dir.path(), Record::Key, 32).is_err());
    }
    #[test]
    fn failed_detector_publication_keeps_last_durable_private_record() {
        let dir = tempfile::tempdir().unwrap();
        write(dir.path(), Record::State, b"complete").unwrap();
        assert!(
            unix::write_before_publish(dir.path(), Record::State, b"new", || Err(
                std::io::Error::other("injected pre-publication failure")
            ))
            .is_err()
        );
        assert_eq!(
            read(dir.path(), Record::State, 32).unwrap().unwrap(),
            b"complete"
        );
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);
    }
}
