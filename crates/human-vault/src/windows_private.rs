//! Private Windows creation. Callers must retain pinned, validated parent handles.
use std::{ffi::c_void, fs::File, io, os::windows::io::FromRawHandle, path::Path, ptr};
use windows_sys::Win32::{
    Foundation::{CloseHandle, LocalFree, HANDLE, INVALID_HANDLE_VALUE},
    Security::{
        Authorization::{
            ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW,
            SDDL_REVISION_1,
        },
        GetTokenInformation, TokenUser, SECURITY_ATTRIBUTES, TOKEN_QUERY, TOKEN_USER,
    },
    Storage::FileSystem::{CreateDirectoryW, CreateFileW},
    System::Threading::{GetCurrentProcess, OpenProcessToken},
};

struct Token(HANDLE);
impl Drop for Token {
    fn drop(&mut self) {
        // SAFETY: this object exclusively owns the process-token handle.
        unsafe { CloseHandle(self.0) };
    }
}

struct LocalAllocation(*mut c_void);
impl Drop for LocalAllocation {
    fn drop(&mut self) {
        // SAFETY: Win32 conversion allocated this pointer with LocalAlloc.
        unsafe { LocalFree(self.0) };
    }
}

pub(crate) fn owner_sid() -> io::Result<String> {
    let mut raw = ptr::null_mut();
    // SAFETY: output points to valid storage; the pseudo process handle is valid.
    if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut raw) } == 0 {
        return Err(io::Error::last_os_error());
    }
    let token = Token(raw);
    let mut length = 0;
    // SAFETY: a zero-sized query intentionally obtains the required buffer size.
    unsafe { GetTokenInformation(token.0, TokenUser, ptr::null_mut(), 0, &mut length) };
    if length == 0 || length > 4096 {
        return Err(io::Error::other("invalid Windows token-user size"));
    }
    // TOKEN_USER requires pointer alignment; a byte vector would not provide it.
    let mut buffer = vec![0_usize; (length as usize).div_ceil(size_of::<usize>())];
    // SAFETY: the aligned buffer is at least the queried length and remains owned.
    if unsafe {
        GetTokenInformation(
            token.0,
            TokenUser,
            buffer.as_mut_ptr().cast(),
            length,
            &mut length,
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: a successful TokenUser query initialized the aligned TOKEN_USER.
    let user = unsafe { &*buffer.as_ptr().cast::<TOKEN_USER>() };
    sid_string(user.User.Sid)
}

pub(crate) fn sid_string(sid: *mut c_void) -> io::Result<String> {
    let mut text = ptr::null_mut();
    // SAFETY: User.Sid references the retained token buffer; output is valid storage.
    if unsafe { ConvertSidToStringSidW(sid, &mut text) } == 0 {
        return Err(io::Error::last_os_error());
    }
    let allocation = LocalAllocation(text.cast());
    let mut units = Vec::new();
    for index in 0..256 {
        // SAFETY: SID strings are NUL-terminated; stop at NUL with a bounded scan.
        let unit = unsafe { *text.add(index) };
        if unit == 0 {
            return String::from_utf16(&units)
                .map_err(|_| io::Error::other("invalid Windows owner SID"));
        }
        units.push(unit);
    }
    drop(allocation);
    Err(io::Error::other("Windows owner SID exceeded its bound"))
}

fn descriptor(directory: bool) -> io::Result<LocalAllocation> {
    let owner = owner_sid()?;
    let inheritance = if directory { "OICI" } else { "" };
    // Protected DACL: no inherited grants to Users/Everyone. Administrators and
    // SYSTEM remain trusted OS principals; the current user owns the object.
    let sddl = format!(
        "O:{owner}D:P(A;{inheritance};FA;;;SY)(A;{inheritance};FA;;;BA)(A;{inheritance};FA;;;{owner})"
    );
    let wide: Vec<u16> = sddl.encode_utf16().chain(Some(0)).collect();
    let mut output = ptr::null_mut();
    // SAFETY: valid NUL-terminated SDDL and initialized output pointer.
    if unsafe {
        ConvertStringSecurityDescriptorToSecurityDescriptorW(
            wide.as_ptr(),
            SDDL_REVISION_1,
            &mut output,
            ptr::null_mut(),
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    Ok(LocalAllocation(output))
}

pub(crate) fn wide_path(path: &Path) -> io::Result<Vec<u16>> {
    use std::os::windows::ffi::OsStrExt;
    let mut units: Vec<u16> = path.as_os_str().encode_wide().collect();
    if units.contains(&0) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "NUL in Windows path",
        ));
    }
    units.push(0);
    Ok(units)
}

pub(crate) fn create_file(
    path: &Path,
    access: u32,
    share: u32,
    disposition: u32,
    flags: u32,
) -> io::Result<File> {
    let path = wide_path(path)?;
    let descriptor = descriptor(false)?;
    let attributes = SECURITY_ATTRIBUTES {
        nLength: u32::try_from(size_of::<SECURITY_ATTRIBUTES>()).expect("fixed Win32 structure"),
        lpSecurityDescriptor: descriptor.0,
        bInheritHandle: 0,
    };
    // SAFETY: all pointers remain owned for the call; handle inheritance is disabled.
    let handle = unsafe {
        CreateFileW(
            path.as_ptr(),
            access,
            share,
            &attributes,
            disposition,
            flags,
            ptr::null_mut(),
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: CreateFileW returned a new, exclusively owned handle.
    Ok(unsafe { File::from_raw_handle(handle.cast()) })
}

pub(crate) fn create_directory(path: &Path) -> io::Result<()> {
    let path = wide_path(path)?;
    let descriptor = descriptor(true)?;
    let attributes = SECURITY_ATTRIBUTES {
        nLength: u32::try_from(size_of::<SECURITY_ATTRIBUTES>()).expect("fixed Win32 structure"),
        lpSecurityDescriptor: descriptor.0,
        bInheritHandle: 0,
    };
    // SAFETY: owned path and security descriptor remain valid throughout creation.
    if unsafe { CreateDirectoryW(path.as_ptr(), &attributes) } == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}
