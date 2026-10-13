//! Actual NTFS write-through handle publication under the private ordered DATA actor.
use super::{handles, publish, security, HeldPrivateRead, PrivateDirectory};
use std::{
    fs::File,
    io::{self, Read, Seek, SeekFrom, Write},
    mem,
    os::windows::io::AsRawHandle,
    path::Path,
    ptr,
    sync::Arc,
};
use windows_sys::Win32::{
    Foundation::{GENERIC_READ, GENERIC_WRITE},
    Storage::FileSystem::{
        CreateFileW, FileDispositionInfo, SetFileInformationByHandle, DELETE,
        FILE_DISPOSITION_INFO, FILE_FLAG_OPEN_REPARSE_POINT, FILE_FLAG_WRITE_THROUGH,
        FILE_READ_ATTRIBUTES, FILE_SHARE_READ, OPEN_EXISTING, READ_CONTROL,
    },
};
const LIMIT: usize = 16 * 1024 * 1024;
fn expected_bytes(
    directory: &Arc<PrivateDirectory>,
    leaf: &Path,
    expected: Option<&[u8]>,
) -> io::Result<()> {
    match HeldPrivateRead::open(Arc::clone(directory), leaf, LIMIT) {
        Ok(mut held) => {
            held.validate()?;
            if expected != Some(held.bytes()) {
                return Err(security::refused());
            }
            held.validate()
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound && expected.is_none() => Ok(()),
        Err(error) => Err(error),
    }
}
fn retained_bytes(file: &mut File, expected: &[u8]) -> io::Result<()> {
    file.seek(SeekFrom::Start(0))?;
    let mut bytes = Vec::new();
    Read::by_ref(file)
        .take(u64::try_from(LIMIT + 1).map_err(|_| security::refused())?)
        .read_to_end(&mut bytes)?;
    if bytes != expected {
        return Err(security::refused());
    }
    Ok(())
}
fn stage_name(stages: &PrivateDirectory) -> io::Result<String> {
    let entries = stages.original_bounded_directory_entries(64)?;
    if entries.len() >= 64 {
        return Err(security::refused());
    }
    for (name, directory) in entries {
        let suffix = name
            .strip_prefix(".opensesame-data-stage-")
            .ok_or_else(security::refused)?;
        let id = uuid::Uuid::parse_str(suffix).map_err(|_| security::refused())?;
        if directory || id.to_string() != suffix {
            return Err(security::refused());
        }
    }
    Ok(format!(".opensesame-data-stage-{}", uuid::Uuid::new_v4()))
}
fn original_for_removal(directory: &PrivateDirectory, leaf: &Path) -> io::Result<File> {
    directory.validate()?;
    let path = handles::wide(&directory.path_for(leaf)?)?;
    // SAFETY: bounded terminated original path; reparse nodes are inspected, never followed.
    // Denying write/delete sharing retains the exact selected source until its handle rename.
    let file = handles::owned(unsafe {
        CreateFileW(
            path.as_ptr(),
            GENERIC_READ | GENERIC_WRITE | DELETE | READ_CONTROL | FILE_READ_ATTRIBUTES,
            FILE_SHARE_READ,
            ptr::null(),
            OPEN_EXISTING,
            FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_WRITE_THROUGH,
            ptr::null_mut(),
        )
    })?;
    publish::check_private(directory, &file, leaf)?;
    Ok(file)
}
fn discard_exact(file: File) -> io::Result<()> {
    let disposition = FILE_DISPOSITION_INFO { DeleteFile: true };
    let size =
        u32::try_from(mem::size_of::<FILE_DISPOSITION_INFO>()).map_err(|_| security::refused())?;
    // SAFETY: retained exact DELETE-capable file handle and valid initialized input remain live.
    if unsafe {
        SetFileInformationByHandle(
            file.as_raw_handle(),
            FileDispositionInfo,
            ptr::from_ref(&disposition).cast(),
            size,
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    // Final close removes only this already detached original inode. Active-name ACK precedes cleanup.
    drop(file);
    Ok(())
}
pub(crate) fn compare_publish(
    directory: &Arc<PrivateDirectory>,
    stages: &Arc<PrivateDirectory>,
    leaf: &Path,
    expected: Option<&[u8]>,
    next: Option<&[u8]>,
    check: impl Fn() -> io::Result<()>,
) -> io::Result<()> {
    if expected.is_some_and(|bytes| bytes.len() > LIMIT)
        || next.is_some_and(|bytes| bytes.len() > LIMIT)
    {
        return Err(security::refused());
    }
    check()?;
    directory.validate()?;
    stages.validate()?;
    let _target = directory.path_for(leaf)?;
    expected_bytes(directory, leaf, expected)?;
    if let Some(bytes) = next {
        return replace(directory, stages, leaf, expected, bytes, &check);
    }
    if let Some(bytes) = expected {
        return remove(directory, stages, leaf, bytes, &check);
    }
    expected_bytes(directory, leaf, None)?;
    check()
}
fn replace(
    directory: &Arc<PrivateDirectory>,
    stages: &Arc<PrivateDirectory>,
    leaf: &Path,
    expected: Option<&[u8]>,
    bytes: &[u8],
    check: &impl Fn() -> io::Result<()>,
) -> io::Result<()> {
    let name = stage_name(stages)?;
    let name = Path::new(&name);
    check()?;
    let mut pending = publish::create_private_with_flags(stages, name, FILE_FLAG_WRITE_THROUGH)?;
    let identity = publish::check_private(stages, &pending.file, name)?;
    pending.file.write_all(bytes)?;
    pending.file.sync_all()?;
    retained_bytes(&mut pending.file, bytes)?;
    if publish::check_private(stages, &pending.file, name)? != identity {
        return Err(security::refused());
    }
    check()?;
    expected_bytes(directory, leaf, expected)?;
    publish::rename_file(&pending.file, directory, leaf, expected.is_some())?;
    pending.published = true;
    // FlushFileBuffers on the same WRITE_THROUGH handle requests data and NTFS rename metadata flush.
    pending.file.sync_all()?;
    if publish::check_private(directory, &pending.file, leaf)? != identity {
        return Err(security::refused());
    }
    retained_bytes(&mut pending.file, bytes)?;
    directory.validate()?;
    stages.validate()?;
    check()
}
fn remove(
    directory: &Arc<PrivateDirectory>,
    stages: &Arc<PrivateDirectory>,
    leaf: &Path,
    expected: &[u8],
    check: &impl Fn() -> io::Result<()>,
) -> io::Result<()> {
    let name = stage_name(stages)?;
    let name = Path::new(&name);
    let mut file = original_for_removal(directory, leaf)?;
    let identity = publish::check_private(directory, &file, leaf)?;
    retained_bytes(&mut file, expected)?;
    check()?;
    if publish::check_private(directory, &file, leaf)? != identity {
        return Err(security::refused());
    }
    // Retained-handle no-overwrite rename detaches the active name with the same metadata flush contract.
    publish::rename_file(&file, stages, name, false)?;
    file.sync_all()?;
    if publish::check_private(stages, &file, name)? != identity {
        return Err(security::refused());
    }
    retained_bytes(&mut file, expected)?;
    expected_bytes(directory, leaf, None)?;
    directory.validate()?;
    stages.validate()?;
    check()?;
    discard_exact(file)?;
    check()
}
#[cfg(test)]
#[path = "compare_publish_tests.rs"]
mod tests;
