//! Conservative owner-private handle policy. No password or vault-root authority.
use std::{ffi::c_void, fs::File, io, mem, os::windows::io::AsRawHandle, ptr};
use windows_sys::Win32::{
    Foundation::{CloseHandle, LocalFree, ERROR_INSUFFICIENT_BUFFER, ERROR_NO_TOKEN, HANDLE},
    Security::{
        Authorization::{
            ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW,
            GetSecurityInfo, SDDL_REVISION_1, SE_FILE_OBJECT,
        },
        EqualSid, GetSecurityDescriptorControl, GetSecurityDescriptorDacl,
        GetSecurityDescriptorLength, GetSecurityDescriptorOwner, GetTokenInformation, IsValidAcl,
        IsValidSecurityDescriptor, IsValidSid, TokenUser, ACL, DACL_SECURITY_INFORMATION,
        OWNER_SECURITY_INFORMATION, SECURITY_ATTRIBUTES, SE_DACL_PROTECTED, SE_SELF_RELATIVE,
        TOKEN_QUERY, TOKEN_USER,
    },
    System::Threading::{GetCurrentProcess, GetCurrentThread, OpenProcessToken, OpenThreadToken},
};

pub(super) fn refused() -> io::Error {
    io::Error::new(
        io::ErrorKind::PermissionDenied,
        "Windows private file IO requires a pinned owner-private object",
    )
}
struct Token(HANDLE);
impl Drop for Token {
    fn drop(&mut self) {
        // SAFETY: this object owns the token handle returned by Windows.
        unsafe { CloseHandle(self.0) };
    }
}
pub(super) struct Descriptor(*mut c_void);
impl Drop for Descriptor {
    fn drop(&mut self) {
        // SAFETY: these allocations are exclusively from LocalAlloc-returning APIs.
        unsafe { LocalFree(self.0) };
    }
}
fn inside(base: *const c_void, size: usize, part: *const c_void, length: usize) -> bool {
    !part.is_null()
        && part
            .addr()
            .checked_sub(base.addr())
            .and_then(|offset| offset.checked_add(length))
            .is_some_and(|end| end <= size)
}
fn bounded_sid(base: *const c_void, size: usize, sid: *mut c_void) -> io::Result<()> {
    if !inside(base, size, sid, 8) {
        return Err(refused());
    }
    // SAFETY: the eight-byte SID header lies within the retained allocation.
    let count = usize::from(unsafe { *sid.cast::<u8>().add(1) });
    if count > 15 || !inside(base, size, sid, 8 + count * 4) {
        return Err(refused());
    }
    // SAFETY: the complete SID is within the checked allocation.
    if unsafe { IsValidSid(sid) } == 0 {
        return Err(refused());
    }
    Ok(())
}
pub(super) fn owner_sid() -> io::Result<String> {
    let mut raw = ptr::null_mut();
    // SAFETY: output is valid; the current thread pseudo-handle is valid.
    if unsafe { OpenThreadToken(GetCurrentThread(), TOKEN_QUERY, 1, &mut raw) } == 0 {
        let error = io::Error::last_os_error();
        if !error
            .raw_os_error()
            .is_some_and(|code| u32::try_from(code) == Ok(ERROR_NO_TOKEN))
        {
            return Err(error);
        }
        // SAFETY: fall back only when there is no impersonation token.
        if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut raw) } == 0 {
            return Err(io::Error::last_os_error());
        }
    }
    let token = Token(raw);
    let token_header = u32::try_from(mem::size_of::<TOKEN_USER>()).map_err(|_| refused())?;
    let mut length = 0;
    // SAFETY: documented zero-sized query obtains the required buffer size.
    let queried =
        unsafe { GetTokenInformation(token.0, TokenUser, ptr::null_mut(), 0, &mut length) };
    if queried != 0
        || !io::Error::last_os_error()
            .raw_os_error()
            .is_some_and(|code| u32::try_from(code) == Ok(ERROR_INSUFFICIENT_BUFFER))
        || length < token_header
        || length > 4096
    {
        return Err(refused());
    }
    let capacity = length;
    let mut buffer = vec![
        0usize;
        usize::try_from(capacity)
            .map_err(|_| refused())?
            .div_ceil(mem::size_of::<usize>())
    ];
    // SAFETY: the owned aligned buffer is at least capacity bytes.
    if unsafe {
        GetTokenInformation(
            token.0,
            TokenUser,
            buffer.as_mut_ptr().cast(),
            capacity,
            &mut length,
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    if length > capacity || length < token_header {
        return Err(refused());
    }
    // SAFETY: the successful bounded TokenUser query initialized the aligned header.
    let sid = unsafe { (*buffer.as_ptr().cast::<TOKEN_USER>()).User.Sid };
    bounded_sid(
        buffer.as_ptr().cast(),
        usize::try_from(length).map_err(|_| refused())?,
        sid,
    )?;
    let mut text = ptr::null_mut();
    // SAFETY: SID is validated and retained, output is initialized.
    if unsafe { ConvertSidToStringSidW(sid, &mut text) } == 0 {
        return Err(io::Error::last_os_error());
    }
    let _allocation = Descriptor(text.cast());
    for end in 0..256 {
        // SAFETY: Windows produces a terminated SID string (maximum below 256 units).
        if unsafe { *text.add(end) } == 0 {
            // SAFETY: the scanned prefix lies in that retained string allocation.
            return String::from_utf16(unsafe { std::slice::from_raw_parts(text, end) })
                .map_err(|_| refused());
        }
    }
    Err(refused())
}
impl Descriptor {
    pub(super) fn private(owner: &str, directory: bool) -> io::Result<Self> {
        let flags = if directory { "OICI" } else { "" };
        let sddl =
            format!("O:{owner}D:P(A;{flags};FA;;;SY)(A;{flags};FA;;;BA)(A;{flags};FA;;;{owner})");
        let wide: Vec<_> = sddl.encode_utf16().chain(Some(0)).collect();
        let mut raw = ptr::null_mut();
        // SAFETY: the internally generated SDDL and output storage remain owned.
        if unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                wide.as_ptr(),
                SDDL_REVISION_1,
                &mut raw,
                ptr::null_mut(),
            )
        } == 0
        {
            return Err(io::Error::last_os_error());
        }
        Ok(Self(raw))
    }
    pub(super) fn attributes(&self) -> io::Result<SECURITY_ATTRIBUTES> {
        Ok(SECURITY_ATTRIBUTES {
            nLength: u32::try_from(mem::size_of::<SECURITY_ATTRIBUTES>()).map_err(|_| refused())?,
            lpSecurityDescriptor: self.0,
            bInheritHandle: 0,
        })
    }
    fn parts(&self) -> io::Result<(*mut c_void, &[u8])> {
        // SAFETY: descriptor is from a retained successful Windows allocation.
        if self.0.is_null() || unsafe { IsValidSecurityDescriptor(self.0) } == 0 {
            return Err(refused());
        }
        let mut control = 0;
        let mut revision = 0;
        // SAFETY: all output pointers are valid.
        if unsafe { GetSecurityDescriptorControl(self.0, &mut control, &mut revision) } == 0
            || control & (SE_SELF_RELATIVE | SE_DACL_PROTECTED)
                != (SE_SELF_RELATIVE | SE_DACL_PROTECTED)
        {
            return Err(refused());
        }
        // SAFETY: the descriptor was validated above.
        let size = usize::try_from(unsafe { GetSecurityDescriptorLength(self.0) })
            .map_err(|_| refused())?;
        if !(20..=65536).contains(&size) {
            return Err(refused());
        }
        let mut owner = ptr::null_mut();
        let mut defaulted = 0;
        let mut present = 0;
        let mut acl: *mut ACL = ptr::null_mut();
        // SAFETY: all outputs are valid and the retained descriptor is validated.
        if unsafe { GetSecurityDescriptorOwner(self.0, &mut owner, &mut defaulted) } == 0
            || unsafe { GetSecurityDescriptorDacl(self.0, &mut present, &mut acl, &mut defaulted) }
                == 0
            || present == 0
            || !inside(self.0, size, acl.cast(), mem::size_of::<ACL>())
        {
            return Err(refused());
        }
        bounded_sid(self.0, size, owner)?;
        // SAFETY: the ACL header lies within the checked descriptor.
        let length = usize::from(unsafe { (*acl).AclSize });
        if length < mem::size_of::<ACL>()
            || !inside(self.0, size, acl.cast(), length)
            || unsafe { IsValidAcl(acl) } == 0
        {
            return Err(refused());
        }
        // SAFETY: the complete ACL belongs to this retained self-relative descriptor.
        Ok((owner, unsafe {
            std::slice::from_raw_parts(acl.cast::<u8>(), length)
        }))
    }
}
pub(super) fn verify(file: &File, owner: &str, directory: bool) -> io::Result<()> {
    let expected = Descriptor::private(owner, directory)?;
    let mut raw = ptr::null_mut();
    // SAFETY: File owns a live handle; optional outputs are documented null pointers.
    let status = unsafe {
        GetSecurityInfo(
            file.as_raw_handle(),
            SE_FILE_OBJECT,
            OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
            ptr::null_mut(),
            ptr::null_mut(),
            ptr::null_mut(),
            ptr::null_mut(),
            &mut raw,
        )
    };
    if status != 0 {
        return Err(io::Error::from_raw_os_error(
            i32::try_from(status).map_err(|_| refused())?,
        ));
    }
    let actual = Descriptor(raw);
    let (expected_owner, expected_acl) = expected.parts()?;
    let (actual_owner, actual_acl) = actual.parts()?;
    // SAFETY: both SIDs were bounded and validated and their allocations are retained.
    if unsafe { EqualSid(expected_owner, actual_owner) } == 0 || expected_acl != actual_acl {
        return Err(refused());
    }
    Ok(())
}
