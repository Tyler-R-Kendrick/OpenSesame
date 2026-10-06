use std::{
    fs::File,
    io, mem,
    os::windows::{ffi::OsStrExt, io::AsRawHandle},
    path::Path,
};
use windows_sys::Win32::{
    Foundation::HANDLE,
    Storage::FileSystem::{
        GetDriveTypeW, GetFileInformationByHandle, GetFileType, GetVolumeInformationW,
        GetVolumePathNameW, BY_HANDLE_FILE_INFORMATION, FILE_ATTRIBUTE_DIRECTORY,
        FILE_ATTRIBUTE_REPARSE_POINT, FILE_TYPE_DISK,
    },
    System::{SystemServices::FILE_PERSISTENT_ACLS, WindowsProgramming::DRIVE_FIXED},
};

pub(super) fn wide(path: &Path) -> Vec<u16> {
    path.as_os_str().encode_wide().chain(Some(0)).collect()
}
pub(super) fn check(file: &File, directory: bool) -> io::Result<()> {
    let handle = file.as_raw_handle() as HANDLE;
    let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { mem::zeroed() };
    // SAFETY: the File owns a live handle and info is a writable correctly sized buffer.
    if unsafe { GetFileInformationByHandle(handle, &mut info) } == 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: handle remains live throughout the call.
    let disk = unsafe { GetFileType(handle) } == FILE_TYPE_DISK;
    let is_dir = info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY != 0;
    if !disk
        || is_dir != directory
        || info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0
        || (!directory && info.nNumberOfLinks != 1)
    {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "Windows storage requires ordinary unlinked files and non-reparse directories",
        ));
    }
    Ok(())
}
pub(super) fn local_ntfs(path: &Path) -> io::Result<()> {
    let input = wide(path);
    let mut volume = [0u16; 32768];
    // SAFETY: input is terminated and volume is a bounded writable buffer.
    if unsafe { GetVolumePathNameW(input.as_ptr(), volume.as_mut_ptr(), volume.len() as u32) } == 0
    {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: the preceding API wrote a terminated volume path.
    if unsafe { GetDriveTypeW(volume.as_ptr()) } != DRIVE_FIXED {
        return Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "Windows storage requires a local fixed NTFS volume",
        ));
    }
    let mut filesystem = [0u16; 32];
    let mut flags = 0;
    // SAFETY: all output pointers are valid or documented optional null pointers.
    if unsafe {
        GetVolumeInformationW(
            volume.as_ptr(),
            std::ptr::null_mut(),
            0,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            &mut flags,
            filesystem.as_mut_ptr(),
            filesystem.len() as u32,
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    let end = filesystem
        .iter()
        .position(|c| *c == 0)
        .unwrap_or(filesystem.len());
    if String::from_utf16_lossy(&filesystem[..end]) != "NTFS" || flags & FILE_PERSISTENT_ACLS == 0 {
        return Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "Windows storage requires NTFS persistent ACLs",
        ));
    }
    Ok(())
}
