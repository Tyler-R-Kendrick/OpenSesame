//! Exact-handle private creation and atomic replacement, not compare-and-set.

use super::{handles, security, PrivateDirectory};
use std::{
    fs::File,
    io::{self, Write},
    mem,
    os::windows::io::AsRawHandle,
    path::Path,
    ptr,
};
use windows_sys::Win32::{
    Foundation::{GENERIC_READ, GENERIC_WRITE},
    Storage::FileSystem::{
        CreateFileW, FileDispositionInfo, FileRenameInfo, SetFileInformationByHandle, CREATE_NEW,
        DELETE, FILE_DISPOSITION_INFO, FILE_FLAG_OPEN_REPARSE_POINT, FILE_READ_ATTRIBUTES,
        FILE_RENAME_INFO, FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING, READ_CONTROL,
    },
};

struct Pending {
    file: File,
    published: bool,
}
impl Drop for Pending {
    fn drop(&mut self) {
        if self.published {
            return;
        }
        let disposition = FILE_DISPOSITION_INFO { DeleteFile: true };
        if let Ok(size) = u32::try_from(mem::size_of::<FILE_DISPOSITION_INFO>()) {
            // SAFETY: the retained DELETE-access handle selects this exact created file.
            unsafe {
                SetFileInformationByHandle(
                    self.file.as_raw_handle(),
                    FileDispositionInfo,
                    ptr::from_ref(&disposition).cast(),
                    size,
                );
            }
        }
    }
}

fn create_private(directory: &PrivateDirectory, name: &Path) -> io::Result<Pending> {
    directory.validate()?;
    let path = handles::wide(&directory.path_for(name)?)?;
    let descriptor = security::Descriptor::private(&directory.owner, false)?;
    let attributes = descriptor.attributes()?;
    // SAFETY: owned terminated path, descriptor and attributes remain live; no inherited handle.
    let handle = unsafe {
        CreateFileW(
            path.as_ptr(),
            GENERIC_READ | GENERIC_WRITE | DELETE | READ_CONTROL | FILE_READ_ATTRIBUTES,
            FILE_SHARE_READ | FILE_SHARE_WRITE,
            &attributes,
            CREATE_NEW,
            FILE_FLAG_OPEN_REPARSE_POINT,
            ptr::null_mut(),
        )
    };
    let pending = Pending {
        file: handles::owned(handle)?,
        published: false,
    };
    check_private(directory, &pending.file, name)?;
    Ok(pending)
}

fn check_private(
    directory: &PrivateDirectory,
    file: &File,
    name: &Path,
) -> io::Result<handles::Identity> {
    directory.validate()?;
    let identity = handles::identity(file, false)?;
    security::verify(file, &directory.owner, false)?;
    let name = name.to_str().ok_or_else(security::refused)?;
    handles::child_relation(directory.root_handle()?, file, name)?;
    Ok(identity)
}

fn inspect_destination(directory: &PrivateDirectory, name: &Path) -> io::Result<()> {
    let path = handles::wide(&directory.path_for(name)?)?;
    // SAFETY: existing final node is inspected without following reparse points.
    // A broad old-file ACL is allowed only because replacement never writes its object.
    let handle = unsafe {
        CreateFileW(
            path.as_ptr(),
            FILE_READ_ATTRIBUTES | READ_CONTROL,
            FILE_SHARE_READ | FILE_SHARE_WRITE,
            ptr::null(),
            OPEN_EXISTING,
            FILE_FLAG_OPEN_REPARSE_POINT,
            ptr::null_mut(),
        )
    };
    match handles::owned(handle) {
        Ok(file) => {
            handles::identity(&file, false)?;
            handles::child_relation(
                directory.root_handle()?,
                &file,
                name.to_str().ok_or_else(security::refused)?,
            )?;
            Ok(())
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}

fn rename_file(
    file: &File,
    directory: &PrivateDirectory,
    name: &Path,
    replace: bool,
) -> io::Result<()> {
    directory.validate()?;
    inspect_destination(directory, name)?;
    let path = handles::wide(&directory.path_for(name)?)?;
    let content_bytes = path
        .len()
        .checked_sub(1)
        .and_then(|units| units.checked_mul(2))
        .ok_or_else(security::refused)?;
    let size = mem::offset_of!(FILE_RENAME_INFO, FileName)
        .checked_add(path.len().checked_mul(2).ok_or_else(security::refused)?)
        .ok_or_else(security::refused)?;
    let mut buffer = vec![0usize; size.div_ceil(mem::size_of::<usize>())];
    let content_bytes = u32::try_from(content_bytes).map_err(|_| security::refused())?;
    let size = u32::try_from(size).map_err(|_| security::refused())?;
    // SAFETY: aligned zeroed allocation contains the complete header and terminated
    // UTF-16 tail. All destination ancestors are retained through this call.
    unsafe {
        let info = buffer.as_mut_ptr().cast::<FILE_RENAME_INFO>();
        (*info).Anonymous.ReplaceIfExists = replace;
        (*info).RootDirectory = ptr::null_mut();
        (*info).FileNameLength = content_bytes;
        ptr::copy_nonoverlapping(
            path.as_ptr(),
            ptr::addr_of_mut!((*info).FileName).cast(),
            path.len(),
        );
        if SetFileInformationByHandle(file.as_raw_handle(), FileRenameInfo, info.cast(), size) == 0
        {
            return Err(io::Error::last_os_error());
        }
    }
    Ok(())
}

/// Exclusively create a private file under the exact retained directory.
///
/// # Errors
/// Refuses existing files, unsupported physical profiles and write/flush errors.
pub fn write_new(directory: &PrivateDirectory, name: &Path, bytes: &[u8]) -> io::Result<()> {
    let mut pending = create_private(directory, name)?;
    let identity = check_private(directory, &pending.file, name)?;
    pending.file.write_all(bytes)?;
    pending.file.sync_all()?;
    if check_private(directory, &pending.file, name)? != identity {
        return Err(security::refused());
    }
    pending.published = true;
    Ok(())
}

/// Replace a leaf atomically with a private file created before its first byte.
/// This is not generation-aware compare-and-set or a fresh-credential gate.
///
/// # Errors
/// Refuses unsafe directory/names, aliases and IO errors. An error after successful
/// rename preserves the complete replacement; it does not claim rollback.
pub fn atomic_write(directory: &PrivateDirectory, name: &Path, bytes: &[u8]) -> io::Result<()> {
    atomic_write_with(directory, name, |file| file.write_all(bytes))
}

/// Stream into a private sibling and publish through its retained exact handle.
/// The trusted producer callback receives a writable File, not an auth verdict.
///
/// # Errors
/// Refuses unsafe paths, failed callbacks, changed physical profiles and IO errors.
pub fn atomic_write_with(
    directory: &PrivateDirectory,
    name: &Path,
    fill: impl FnOnce(&mut File) -> io::Result<()>,
) -> io::Result<()> {
    publish_with(directory, name, true, fill)
}

/// Publish a fully flushed private stage only when the destination remains absent.
/// The exact retained handle rename never replaces a raced destination.
/// This is a physical operation, not an owner authentication grant.
/// # Errors
/// Refuses existing destinations, unsafe profiles, failed callbacks and IO errors.
pub fn atomic_create_with(
    directory: &PrivateDirectory,
    name: &Path,
    fill: impl FnOnce(&mut File) -> io::Result<()>,
) -> io::Result<()> {
    publish_with(directory, name, false, fill)
}

fn publish_with(
    directory: &PrivateDirectory,
    name: &Path,
    replace: bool,
    fill: impl FnOnce(&mut File) -> io::Result<()>,
) -> io::Result<()> {
    let _destination = directory.path_for(name)?;
    let pending_name = format!(".opensesame-private-{}", uuid::Uuid::new_v4());
    let pending_name = Path::new(&pending_name);
    let mut pending = create_private(directory, pending_name)?;
    let identity = check_private(directory, &pending.file, pending_name)?;
    fill(&mut pending.file)?;
    pending.file.sync_all()?;
    if check_private(directory, &pending.file, pending_name)? != identity {
        return Err(security::refused());
    }
    rename_file(&pending.file, directory, name, replace)?;
    pending.published = true;
    pending.file.sync_all()?;
    if check_private(directory, &pending.file, name)? != identity {
        return Err(security::refused());
    }
    Ok(())
}

#[cfg(test)]
#[path = "publish_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "publish_create_tests.rs"]
mod publish_create_tests;
