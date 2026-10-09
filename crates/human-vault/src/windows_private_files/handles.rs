//! Every ancestor pin denies delete-sharing and survives for the StoreLock lifetime.
use super::security::refused;
use std::{
    fs::File,
    io, mem,
    os::windows::io::{AsRawHandle, FromRawHandle},
    path::{Path, PathBuf},
    ptr,
};
use windows_sys::Win32::{
    Foundation::{HANDLE, INVALID_HANDLE_VALUE},
    Storage::FileSystem::{
        CreateFileW, GetDriveTypeW, GetFileInformationByHandle, GetFileType,
        GetFinalPathNameByHandleW, GetShortPathNameW, GetVolumeInformationByHandleW,
        BY_HANDLE_FILE_INFORMATION, FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_REPARSE_POINT,
        FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_LIST_DIRECTORY,
        FILE_READ_ATTRIBUTES, FILE_SHARE_READ, FILE_SHARE_WRITE, FILE_TYPE_DISK, OPEN_EXISTING,
        READ_CONTROL,
    },
    System::{SystemServices::FILE_PERSISTENT_ACLS, WindowsProgramming::DRIVE_FIXED},
};

pub(super) fn prefixes(root: &Path) -> io::Result<Vec<PathBuf>> {
    let text = root.to_str().ok_or_else(refused)?;
    let bytes = text.as_bytes();
    if bytes.len() <= 3
        || !bytes[0].is_ascii_alphabetic()
        || bytes[1] != b':'
        || bytes[2] != b'\\'
        || text.encode_utf16().count() > 32760
    {
        return Err(refused());
    }
    let mut path = PathBuf::from(&text[..3]);
    let mut result = vec![path.clone()];
    for component in text[3..].split('\\') {
        component_policy(component)?;
        path.push(component);
        result.push(path.clone());
        if result.len() > 128 {
            return Err(refused());
        }
    }
    Ok(result)
}
pub(super) fn component_policy(value: &str) -> io::Result<()> {
    if value.is_empty()
        || value == "."
        || value == ".."
        || value.ends_with(['.', ' '])
        || value.encode_utf16().count() > 255
        || value
            .chars()
            .any(|c| c.is_control() || "<>:\"/\\|?*".contains(c))
    {
        return Err(refused());
    }
    let stem = value.split('.').next().unwrap_or("").to_ascii_uppercase();
    if ["CON", "PRN", "AUX", "NUL", "CLOCK$", "CONIN$", "CONOUT$"].contains(&stem.as_str())
        || (stem.starts_with("COM") || stem.starts_with("LPT"))
            && stem[3..].chars().count() == 1
            && "123456789¹²³".contains(&stem[3..])
    {
        return Err(refused());
    }
    Ok(())
}
fn ordinary_dos_text(path: &Path) -> io::Result<&str> {
    let text = path.to_str().ok_or_else(refused)?;
    let bytes = text.as_bytes();
    if bytes.len() < 3
        || !bytes[0].is_ascii_alphabetic()
        || bytes[1] != b':'
        || bytes[2] != b'\\'
        || text.encode_utf16().count() > 32760
    {
        return Err(refused());
    }
    if bytes.len() > 3 {
        for component in text[3..].split('\\') {
            component_policy(component)?;
        }
    }
    Ok(text)
}
// Only internal API spelling changes. Public/captured paths remain strict ordinary DOS;
// callers cannot supply verbatim/UNC/device/dot aliases to bypass component policy.
pub(super) fn wide(path: &Path) -> io::Result<Vec<u16>> {
    let text = ordinary_dos_text(path)?;
    Ok(r"\\?\"
        .encode_utf16()
        .chain(text.encode_utf16())
        .chain(Some(0))
        .collect())
}
pub(super) fn directory(path: &Path) -> io::Result<File> {
    let path = wide(path)?;
    // SAFETY: the bounded terminated path is retained; no inheritable handles.
    let handle = unsafe {
        CreateFileW(
            path.as_ptr(),
            FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES | READ_CONTROL,
            FILE_SHARE_READ | FILE_SHARE_WRITE,
            ptr::null(),
            OPEN_EXISTING,
            FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS,
            ptr::null_mut(),
        )
    };
    owned(handle)
}
pub(super) fn owned(handle: HANDLE) -> io::Result<File> {
    if handle == INVALID_HANDLE_VALUE {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: the caller passes only a newly returned exclusively owned CreateFileW handle.
    Ok(unsafe { File::from_raw_handle(handle) })
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct Identity(u32, u32, u32);
pub(super) fn identity(file: &File, directory: bool) -> io::Result<Identity> {
    // SAFETY: this Win32 output structure permits all-zero initialization.
    let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { mem::zeroed() };
    // SAFETY: File owns the handle and info is a correctly sized writable buffer.
    if unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut info) } == 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: the handle is live throughout this call.
    if unsafe { GetFileType(file.as_raw_handle()) } != FILE_TYPE_DISK
        || (info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY != 0) != directory
        || info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0
        || (!directory && info.nNumberOfLinks != 1)
    {
        return Err(refused());
    }
    Ok(Identity(
        info.dwVolumeSerialNumber,
        info.nFileIndexHigh,
        info.nFileIndexLow,
    ))
}
pub(super) fn final_path(file: &File) -> io::Result<String> {
    let mut buffer = vec![0u16; 32768];
    // SAFETY: handle remains live; the bounded output buffer is valid. Flags zero
    // requests normalized DOS volume paths, not user-supplied spelling.
    let length =
        unsafe { GetFinalPathNameByHandleW(file.as_raw_handle(), buffer.as_mut_ptr(), 32768, 0) };
    if length == 0 {
        return Err(io::Error::last_os_error());
    }
    let length = usize::try_from(length).map_err(|_| refused())?;
    if length >= buffer.len() {
        return Err(refused());
    }
    let text = String::from_utf16(&buffer[..length]).map_err(|_| refused())?;
    if !text.starts_with("\\\\?\\") || text.as_bytes().get(5) != Some(&b':') {
        return Err(refused());
    }
    Ok(text)
}
pub(super) fn drive_relation(file: &File, drive: &Path) -> io::Result<()> {
    let expected = format!("\\\\?\\{}", drive.to_str().ok_or_else(refused)?);
    if !final_path(file)?.eq_ignore_ascii_case(&expected) {
        return Err(refused());
    }
    Ok(())
}
pub(super) fn child_relation(parent: &File, child: &File, name: &str) -> io::Result<()> {
    let parent = final_path(parent)?;
    let child = final_path(child)?;
    let (directory, leaf) = child.rsplit_once('\\').ok_or_else(refused)?;
    if directory != parent.trim_end_matches('\\') {
        return Err(refused());
    }
    if leaf.eq_ignore_ascii_case(name) {
        return Ok(());
    }
    // Every parent and this exact child are already held without delete sharing.
    // Only the kernel-reported short name of this same selected node can match.
    let short = short_path(&child)?;
    let (_, short_leaf) = short.rsplit_once('\\').ok_or_else(refused)?;
    if !short_leaf.eq_ignore_ascii_case(name) {
        return Err(refused());
    }
    Ok(())
}

pub(super) fn short_path(path: &str) -> io::Result<String> {
    // This input comes only from the actual held child's kernel-reported final path.
    // Convert its known DOS prefix through the same strict encoder, never a public alias.
    let path = path.strip_prefix(r"\\?\").ok_or_else(refused)?;
    let path = wide(Path::new(path))?;
    let mut buffer = vec![0u16; 32768];
    // SAFETY: retained terminated actual handle path and bounded output stay live.
    let length = unsafe { GetShortPathNameW(path.as_ptr(), buffer.as_mut_ptr(), 32768) };
    if length == 0 {
        return Err(io::Error::last_os_error());
    }
    let length = usize::try_from(length).map_err(|_| refused())?;
    if length >= buffer.len() {
        return Err(refused());
    }
    String::from_utf16(&buffer[..length]).map_err(|_| refused())
}
pub(super) fn local_ntfs(root: &File, drive: &Path) -> io::Result<()> {
    let drive = ordinary_dos_text(drive)?;
    if drive.len() != 3 {
        return Err(refused());
    }
    let drive = drive.encode_utf16().chain(Some(0)).collect::<Vec<_>>();
    // SAFETY: drive is an internally parsed terminated ordinary DOS drive root.
    if unsafe { GetDriveTypeW(drive.as_ptr()) } != DRIVE_FIXED {
        return Err(refused());
    }
    let mut filesystem = [0u16; 32];
    let mut flags = 0;
    // SAFETY: the held root handle determines the actual volume; optional outputs
    // are null, and both requested writable buffers remain live.
    if unsafe {
        GetVolumeInformationByHandleW(
            root.as_raw_handle(),
            ptr::null_mut(),
            0,
            ptr::null_mut(),
            ptr::null_mut(),
            &mut flags,
            filesystem.as_mut_ptr(),
            32,
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    let end = filesystem
        .iter()
        .position(|v| *v == 0)
        .ok_or_else(refused)?;
    if filesystem[..end] != [78, 84, 70, 83] || flags & FILE_PERSISTENT_ACLS == 0 {
        return Err(refused());
    }
    Ok(())
}

impl Identity {
    pub(super) fn resource_binding(self) -> String {
        format!("windows:{}:{}:{}", self.0, self.1, self.2)
    }
}
