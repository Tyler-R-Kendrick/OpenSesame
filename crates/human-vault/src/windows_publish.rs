//! Publish private files through exact source handles and pinned destination parents.
//! FlushFileBuffers surrounds publication; process interruption preserves complete files.
#[path = "windows_detector_key.rs"]
pub mod detector_key;

use crate::{
    windows_io::{open_regular, PinnedParent},
    windows_private,
};
use std::{
    fs::File,
    io::{self, Write},
    mem,
    os::windows::io::AsRawHandle,
    path::Path,
    ptr,
};
use windows_sys::Win32::{
    Foundation::GENERIC_WRITE,
    Storage::FileSystem::{
        FileDispositionInfo, FileRenameInfo, SetFileInformationByHandle, CREATE_NEW, DELETE,
        FILE_DISPOSITION_INFO, FILE_READ_ATTRIBUTES, FILE_RENAME_INFO, OPEN_EXISTING,
    },
};

struct Pending {
    file: File,
    _parent: PinnedParent,
    published: bool,
}
impl Drop for Pending {
    fn drop(&mut self) {
        if self.published {
            return;
        }
        let disposition = FILE_DISPOSITION_INFO { DeleteFile: 1 };
        // SAFETY: retained DELETE-access handle; cleanup addresses that exact file.
        unsafe {
            SetFileInformationByHandle(
                self.file.as_raw_handle().cast(),
                FileDispositionInfo,
                ptr::from_ref(&disposition).cast(),
                u32::try_from(size_of::<FILE_DISPOSITION_INFO>()).expect("fixed Win32 structure"),
            );
        }
    }
}

fn rename_file(file: &File, destination: &PinnedParent) -> io::Result<()> {
    // Inspect the final node without following it. Release only this final
    // handle before replacement; retaining it without DELETE sharing would
    // block our own rename. Pinned private parents remain held throughout.
    match open_regular(destination.path(), FILE_READ_ATTRIBUTES, OPEN_EXISTING) {
        Ok(existing) => drop(existing),
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(error),
    }
    // Retain an explicit terminator for the Win32 path conversion, while the
    // content length excludes it. Never depend on allocation alignment padding.
    let name = windows_private::wide_path(destination.path())?;
    let content_bytes = name
        .len()
        .checked_sub(1)
        .and_then(|units| units.checked_mul(2))
        .ok_or_else(|| io::Error::other("Windows rename filename exceeded its bound"))?;
    let offset = mem::offset_of!(FILE_RENAME_INFO, FileName);
    let size = offset
        .checked_add(
            name.len()
                .checked_mul(2)
                .ok_or_else(|| io::Error::other("Windows rename path exceeded its bound"))?,
        )
        .ok_or_else(|| io::Error::other("Windows rename buffer exceeded its bound"))?;
    let mut buffer = vec![0_usize; size.div_ceil(size_of::<usize>())];
    // SAFETY: aligned allocation covers the structure and flexible UTF-16 tail.
    unsafe {
        let info = buffer.as_mut_ptr().cast::<FILE_RENAME_INFO>();
        (*info).Anonymous.ReplaceIfExists = 1;
        (*info).RootDirectory = ptr::null_mut();
        (*info).FileNameLength = u32::try_from(content_bytes)
            .map_err(|_| io::Error::other("Windows rename filename exceeded its bound"))?;
        ptr::copy_nonoverlapping(
            name.as_ptr(),
            ptr::addr_of_mut!((*info).FileName).cast(),
            name.len(),
        );
        if SetFileInformationByHandle(
            file.as_raw_handle().cast(),
            FileRenameInfo,
            info.cast(),
            u32::try_from(size)
                .map_err(|_| io::Error::other("Windows rename exceeded its bound"))?,
        ) == 0
        {
            return Err(io::Error::last_os_error());
        }
    }
    Ok(())
}

/// Replace a regular file without re-opening its source pathname during publication.
/// # Errors
/// Refuses unsupported volumes, reparse paths, broad permissions and IO failures.
pub fn rename(root: &Path, source: &Path, destination: &Path) -> io::Result<()> {
    let source_parent = PinnedParent::open(root, source, false)?;
    let destination_parent = PinnedParent::open(root, destination, false)?;
    let file = open_regular(source_parent.path(), DELETE | GENERIC_WRITE, OPEN_EXISTING)?;
    file.sync_all()?;
    rename_file(&file, &destination_parent)?;
    file.sync_all()
}

/// Exclusively create and flush a private file under pinned parents.
/// # Errors
/// Refuses existing files, unsafe permissions/paths and IO failures.
pub fn write_new(root: &Path, relative: &Path, bytes: &[u8]) -> io::Result<()> {
    let parent = PinnedParent::open(root, relative, true)?;
    let mut file = open_regular(parent.path(), GENERIC_WRITE, CREATE_NEW)?;
    file.write_all(bytes)?;
    file.sync_all()
}

/// Publish either the last complete value or its complete replacement.
/// # Errors
/// Refuses unsafe paths, permissions, unsupported volumes and publication failures.
pub fn atomic_write(root: &Path, relative: &Path, bytes: &[u8]) -> io::Result<()> {
    atomic_write_before_publish(root, relative, bytes, || Ok(()))
}

fn atomic_write_before_publish(
    root: &Path,
    relative: &Path,
    bytes: &[u8],
    before_publish: impl FnOnce() -> io::Result<()>,
) -> io::Result<()> {
    atomic_transaction(root, relative, bytes, before_publish, File::sync_all)
}

fn atomic_transaction(
    root: &Path,
    relative: &Path,
    bytes: &[u8],
    before_publish: impl FnOnce() -> io::Result<()>,
    after_publish: impl FnOnce(&File) -> io::Result<()>,
) -> io::Result<()> {
    atomic_fill_transaction(
        root,
        relative,
        |file| file.write_all(bytes),
        before_publish,
        after_publish,
    )
}

/// Stream a private file into exact-handle, atomic publication.
/// # Errors
/// Refuses unsafe paths, permissions, unsupported volumes and callback/publication failures.
pub fn atomic_write_with(
    root: &Path,
    relative: &Path,
    fill: impl FnOnce(&mut File) -> io::Result<()>,
) -> io::Result<()> {
    atomic_fill_transaction(root, relative, fill, || Ok(()), File::sync_all)
}

fn atomic_fill_transaction(
    root: &Path,
    relative: &Path,
    fill: impl FnOnce(&mut File) -> io::Result<()>,
    before_publish: impl FnOnce() -> io::Result<()>,
    after_publish: impl FnOnce(&File) -> io::Result<()>,
) -> io::Result<()> {
    let destination = PinnedParent::open(root, relative, true)?;
    let pending_relative =
        relative.with_file_name(format!(".windows-pending-{}", uuid::Uuid::new_v4()));
    let parent = PinnedParent::open(root, &pending_relative, false)?;
    let file = open_regular(parent.path(), GENERIC_WRITE | DELETE, CREATE_NEW)?;
    let mut pending = Pending {
        file,
        _parent: parent,
        published: false,
    };
    fill(&mut pending.file)?;
    pending.file.sync_all()?;
    before_publish()?;
    rename_file(&pending.file, &destination)?;
    pending.published = true;
    after_publish(&pending.file)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn stream_fill_failure_preserves_complete_value_and_cleans_exact_pending_file() {
        let dir = tempfile::tempdir().unwrap();
        let name = Path::new("records.json");
        atomic_write(dir.path(), name, b"committed").unwrap();
        let result = atomic_write_with(dir.path(), name, |file| {
            file.write_all(b"incomplete")?;
            Err(io::Error::other("genuine streaming fill failure"))
        });
        assert!(result.is_err());
        assert_eq!(
            crate::windows_io::read_bounded(dir.path(), name, 64).unwrap(),
            b"committed"
        );
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);
    }

    #[test]
    fn stream_callback_receives_private_file_under_pinned_parent_until_publish() {
        let dir = tempfile::tempdir().unwrap();
        let name = Path::new("streamed.json");
        atomic_write_with(dir.path(), name, |file| {
            file.write_all(b"private stream")?;
            file.flush()?;
            let pending = std::fs::read_dir(dir.path())?.next().unwrap()?.file_name();
            assert!(dir.path().join(pending).is_file());
            crate::windows_acl::verify_file(file)?;
            assert!(std::fs::rename(dir.path(), dir.path().with_extension("moved")).is_err());
            Ok(())
        })
        .unwrap();
        assert_eq!(
            crate::windows_io::read_bounded(dir.path(), name, 64).unwrap(),
            b"private stream"
        );
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);
        let moved = dir.path().with_extension("moved");
        std::fs::rename(dir.path(), &moved).unwrap();
        std::fs::rename(&moved, dir.path()).unwrap();
    }

    #[test]
    fn post_publication_flush_failure_never_deletes_the_committed_value() {
        let dir = tempfile::tempdir().unwrap();
        let name = Path::new("records.json");
        atomic_write(dir.path(), name, b"complete previous").unwrap();
        let result = atomic_transaction(
            dir.path(),
            name,
            b"complete replacement",
            || Ok(()),
            |_| Err(io::Error::other("injected post-publication flush failure")),
        );
        assert!(result.is_err());
        assert_eq!(
            crate::windows_io::read_bounded(dir.path(), name, 64).unwrap(),
            b"complete replacement"
        );
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);
    }
    #[test]
    fn failed_publication_preserves_complete_value_and_cleans_exact_pending_file() {
        let dir = tempfile::tempdir().unwrap();
        let name = Path::new("records.json");
        atomic_write(dir.path(), name, b"complete previous").unwrap();
        assert!(
            atomic_write_before_publish(dir.path(), name, b"replacement", || {
                Err(io::Error::other("injected before publish"))
            })
            .is_err()
        );
        assert_eq!(
            crate::windows_io::read_bounded(dir.path(), name, 64).unwrap(),
            b"complete previous"
        );
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);
        atomic_write(dir.path(), name, b"complete next").unwrap();
        assert_eq!(
            crate::windows_io::read_bounded(dir.path(), name, 64).unwrap(),
            b"complete next"
        );
        // Full-path UTF-16 lengths exercise each alignment residue, including
        // buffers whose old allocation had no incidental NUL padding.
        for padding in 0..4 {
            let filename = format!("{}records.json", "x".repeat(padding));
            let relative = Path::new(&filename);
            atomic_write(dir.path(), relative, b"first complete").unwrap();
            atomic_write(dir.path(), relative, b"next complete").unwrap();
            assert_eq!(
                crate::windows_io::read_bounded(dir.path(), relative, 64).unwrap(),
                b"next complete"
            );
            crate::windows_io::remove(dir.path(), relative).unwrap();
        }
    }

    #[test]
    fn process_exit_before_publication_preserves_complete_value() {
        const ENV: &str = "OPENSESAME_TEST_WINDOWS_PUBLISH_ROOT";
        if let Some(root) = std::env::var_os(ENV) {
            let _ = atomic_write_before_publish(
                Path::new(&root),
                Path::new("records.json"),
                b"interrupted",
                || std::process::exit(23),
            );
            panic!("process-exit hook was not reached");
        }
        let dir = tempfile::tempdir().unwrap();
        atomic_write(dir.path(), Path::new("records.json"), b"complete previous").unwrap();
        let child = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "windows_publish::tests::process_exit_before_publication_preserves_complete_value",
                "--nocapture",
            ])
            .env(ENV, dir.path())
            .output()
            .unwrap();
        assert_eq!(child.status.code(), Some(23));
        assert_eq!(
            crate::windows_io::read_bounded(dir.path(), Path::new("records.json"), 64).unwrap(),
            b"complete previous"
        );
        atomic_write(dir.path(), Path::new("records.json"), b"complete next").unwrap();
        assert_eq!(
            crate::windows_io::read_bounded(dir.path(), Path::new("records.json"), 64).unwrap(),
            b"complete next"
        );
    }
}
