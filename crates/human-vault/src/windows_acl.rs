//! Validate permissions on already pinned Windows handles, never pathname ACLs.
use std::{ffi::c_void, fs::File, io, os::windows::io::AsRawHandle, ptr};
use windows_sys::Win32::{
    Foundation::LocalFree,
    Security::{
        Authorization::{GetSecurityInfo, SE_FILE_OBJECT},
        GetAce, ACCESS_ALLOWED_ACE, ACE_HEADER, ACL, DACL_SECURITY_INFORMATION, INHERIT_ONLY_ACE,
        OWNER_SECURITY_INFORMATION,
    },
    System::SystemServices::{ACCESS_ALLOWED_ACE_TYPE, ACCESS_DENIED_ACE_TYPE},
};

struct SecurityDescriptor(*mut c_void);
impl Drop for SecurityDescriptor {
    fn drop(&mut self) {
        // SAFETY: GetSecurityInfo allocated this descriptor with LocalAlloc.
        unsafe { LocalFree(self.0) };
    }
}

fn refused() -> io::Error {
    io::Error::new(
        io::ErrorKind::PermissionDenied,
        "Windows store permissions are not private",
    )
}

fn trusted(sid: &str, owner: &str, inherit_only: bool) -> bool {
    sid == owner || sid == "S-1-5-18" || sid == "S-1-5-32-544" || (inherit_only && sid == "S-1-3-0")
    // CREATOR OWNER applies to the private creator.
}

fn verify_private(file: &File) -> io::Result<()> {
    let current_owner = super::windows_private::owner_sid()?;
    let mut owner = ptr::null_mut();
    let mut acl: *mut ACL = ptr::null_mut();
    let mut raw = ptr::null_mut();
    // SAFETY: the retained file owns the handle; all outputs point to valid storage.
    let status = unsafe {
        GetSecurityInfo(
            file.as_raw_handle().cast(),
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION | OWNER_SECURITY_INFORMATION,
            &mut owner,
            ptr::null_mut(),
            &mut acl,
            ptr::null_mut(),
            &mut raw,
        )
    };
    if status != 0 {
        return Err(io::Error::from_raw_os_error(
            i32::try_from(status).unwrap_or(i32::MAX),
        ));
    }
    let _descriptor = SecurityDescriptor(raw);
    if owner.is_null() || acl.is_null() {
        return Err(refused());
    }
    if !trusted(
        &super::windows_private::sid_string(owner)?,
        &current_owner,
        false,
    ) {
        return Err(refused());
    }
    // SAFETY: GetSecurityInfo supplied a valid DACL retained by _descriptor.
    let count = unsafe { (*acl).AceCount };
    if count > 128 {
        return Err(refused());
    }
    for index in 0..u32::from(count) {
        let mut raw_ace = ptr::null_mut();
        // SAFETY: index is within the validated DACL's ACE count.
        if unsafe { GetAce(acl, index, &mut raw_ace) } == 0 {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: a successful GetAce returns an initialized ACE header.
        let header = unsafe { &*raw_ace.cast::<ACE_HEADER>() };
        if u32::from(header.AceType) == ACCESS_DENIED_ACE_TYPE {
            continue;
        }
        // Fail closed on conditional/object-specific ACEs rather than interpreting
        // a subset of their permissions as if they were ordinary allow ACEs.
        if u32::from(header.AceType) != ACCESS_ALLOWED_ACE_TYPE
            || usize::from(header.AceSize) < size_of::<ACCESS_ALLOWED_ACE>()
        {
            return Err(refused());
        }
        // SAFETY: the ordinary allow ACE type and minimum size were checked.
        let ace = unsafe { &*raw_ace.cast::<ACCESS_ALLOWED_ACE>() };
        let sid =
            super::windows_private::sid_string(ptr::from_ref(&ace.SidStart).cast_mut().cast())?;
        let inherit_only = u32::from(header.AceFlags) & INHERIT_ONLY_ACE != 0;
        if !trusted(&sid, &current_owner, inherit_only) {
            return Err(refused());
        }
    }
    Ok(())
}

/// Vault roots and descendants must hide both contents and directory listings.
/// Ordinary OS ancestors use only windows_io's pinned non-reparse validation;
/// they are deliberately not passed to this owner-private policy.
pub(crate) fn verify_directory(file: &File) -> io::Result<()> {
    verify_private(file)
}
pub(crate) fn verify_file(file: &File) -> io::Result<()> {
    verify_private(file)
}
