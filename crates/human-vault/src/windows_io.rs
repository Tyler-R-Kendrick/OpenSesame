//! Confined Windows IO. Support remains gated until hosted Windows tests pass.
//! Ancestor handles deny deletion while each operation/lock is live.
mod handles;
mod path;

use crate::{windows_acl, windows_private};
use std::{
    fs::File,
    io::{self, Read, Write},
    mem,
    os::windows::io::AsRawHandle,
    path::{Path, PathBuf},
};
use windows_sys::Win32::{
    Foundation::{ERROR_LOCK_VIOLATION, GENERIC_READ, GENERIC_WRITE, HANDLE},
    Storage::FileSystem::{
        FileDispositionInfo, LockFileEx, SetFileInformationByHandle, DELETE, FILE_DISPOSITION_INFO,
        FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_READ_ATTRIBUTES,
        FILE_SHARE_READ, FILE_SHARE_WRITE, LOCKFILE_EXCLUSIVE_LOCK, LOCKFILE_FAIL_IMMEDIATELY,
        OPEN_ALWAYS, OPEN_EXISTING, READ_CONTROL,
    },
    System::IO::OVERLAPPED,
};

const SHARING: u32 = FILE_SHARE_READ | FILE_SHARE_WRITE;
const ATTRIBUTES: u32 = FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS;

pub struct PinnedParent {
    _ancestors: Vec<File>,
    final_path: PathBuf,
}
impl PinnedParent {
    /// Pin all existing root ancestors and confined parents, optionally creating
    /// missing confined directories with an owner-only protected DACL.
    pub fn open(root: &Path, relative: &Path, create: bool) -> io::Result<Self> {
        let roots = path::root(root)?;
        let relatives = path::relative(relative)?;
        let final_path = root.join(relative);
        if roots.len() + relatives.len() > 128
            || final_path.to_string_lossy().encode_utf16().count() > 32760
        {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "Windows storage path exceeds confinement bounds",
            ));
        }
        let mut ancestors = Vec::new();
        for ancestor in &roots {
            ancestors.push(open_directory(ancestor)?);
        }
        let root_handle = ancestors
            .last()
            .ok_or_else(|| io::Error::other("missing root handle"))?;
        windows_acl::verify_directory(root_handle)?;
        handles::local_ntfs(root)?;
        for parent in relatives.iter().take(relatives.len() - 1) {
            let absolute = root.join(parent);
            if create {
                create_if_missing(&absolute)?;
            }
            let directory = open_directory(&absolute)?;
            windows_acl::verify_directory(&directory)?;
            ancestors.push(directory);
        }
        Ok(Self {
            _ancestors: ancestors,
            final_path,
        })
    }
    pub fn path(&self) -> &Path {
        &self.final_path
    }
}
fn create_if_missing(path: &Path) -> io::Result<()> {
    match windows_private::create_directory(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => Ok(()),
        Err(error) => Err(error),
    }
}
fn open_directory(path: &Path) -> io::Result<File> {
    let file = windows_private::create_file(
        path,
        FILE_READ_ATTRIBUTES | READ_CONTROL,
        SHARING,
        OPEN_EXISTING,
        ATTRIBUTES,
    )?;
    handles::check(&file, true)?;
    Ok(file)
}
pub(crate) fn open_regular(path: &Path, access: u32, disposition: u32) -> io::Result<File> {
    let file = windows_private::create_file(
        path,
        access | FILE_READ_ATTRIBUTES | READ_CONTROL,
        SHARING,
        disposition,
        FILE_FLAG_OPEN_REPARSE_POINT,
    )?;
    handles::check(&file, false)?;
    windows_acl::verify_file(&file)?;
    Ok(file)
}
pub fn read_bounded(root: &Path, relative: &Path, max: usize) -> io::Result<Vec<u8>> {
    let parent = PinnedParent::open(root, relative, false)?;
    let file = open_regular(parent.path(), GENERIC_READ, OPEN_EXISTING)?;
    let limit = u64::try_from(max).map_err(|_| io::Error::other("invalid read bound"))?;
    if file.metadata()?.len() > limit {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "Windows storage file exceeds size bound",
        ));
    }
    let mut bytes = Vec::new();
    file.take(limit.saturating_add(1)).read_to_end(&mut bytes)?;
    if bytes.len() > max {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "Windows storage file exceeds size bound",
        ));
    }
    Ok(bytes)
}
/// In-place write for non-transactional callers. Key/journal publication uses
/// windows_publish::atomic_write instead.
pub fn write(root: &Path, relative: &Path, bytes: &[u8]) -> io::Result<()> {
    let parent = PinnedParent::open(root, relative, true)?;
    let mut file = open_regular(parent.path(), GENERIC_WRITE, OPEN_ALWAYS)?;
    file.set_len(0)?;
    file.write_all(bytes)?;
    file.sync_all()
}
pub fn remove(root: &Path, relative: &Path) -> io::Result<()> {
    let parent = PinnedParent::open(root, relative, false)?;
    let file = open_regular(parent.path(), DELETE, OPEN_EXISTING)?;
    let disposition = FILE_DISPOSITION_INFO { DeleteFile: 1 };
    // SAFETY: the file owns a live DELETE-access handle; disposition is a valid
    // buffer of the documented FILE_DISPOSITION_INFO size, and deletion is
    // attached to that exact opened regular file rather than a later path lookup.
    if unsafe {
        SetFileInformationByHandle(
            file.as_raw_handle() as HANDLE,
            FileDispositionInfo,
            &disposition as *const _ as *const _,
            mem::size_of::<FILE_DISPOSITION_INFO>() as u32,
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}
pub fn create_dir(root: &Path, relative: &Path) -> io::Result<()> {
    let parent = PinnedParent::open(root, relative, true)?;
    windows_private::create_directory(parent.path())?;
    let file = open_directory(parent.path())?;
    windows_acl::verify_directory(&file)
}
/// Owns both the lock file and ancestor pins until drop. LockFileEx locks are
/// nonblocking and released by the OS when the owning handle closes.
pub struct WindowsLock {
    _file: File,
    _parent: PinnedParent,
}
pub fn lock(root: &Path, relative: &Path, exclusive: bool) -> io::Result<WindowsLock> {
    let parent = PinnedParent::open(root, relative, true)?;
    let file = open_regular(parent.path(), GENERIC_READ | GENERIC_WRITE, OPEN_ALWAYS)?;
    let mut overlapped: OVERLAPPED = unsafe { mem::zeroed() };
    let flags = LOCKFILE_FAIL_IMMEDIATELY
        | if exclusive {
            LOCKFILE_EXCLUSIVE_LOCK
        } else {
            0
        };
    // SAFETY: the handle stays owned by WindowsLock, the writable OVERLAPPED
    // remains live during this synchronous call, and byte range [0,1) is fixed.
    if unsafe {
        LockFileEx(
            file.as_raw_handle() as HANDLE,
            flags,
            0,
            1,
            0,
            &mut overlapped,
        )
    } == 0
    {
        let error = io::Error::last_os_error();
        if error
            .raw_os_error()
            .is_some_and(|code| u32::try_from(code) == Ok(ERROR_LOCK_VIOLATION))
        {
            return Err(io::Error::new(io::ErrorKind::WouldBlock, error));
        }
        return Err(error);
    }
    Ok(WindowsLock {
        _file: file,
        _parent: parent,
    })
}

#[cfg(test)]
mod tests;
