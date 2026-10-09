//! Shared original-root native writer protocol; actual kernel serialization never proves owner authority.
use super::{handles, security, PrivateDirectory};
use crate::root_protection::physical_writer_lease::physical_writer_lease_name;
use std::{fs::File, io, os::windows::io::AsRawHandle, path::Path, ptr, sync::Arc};
use windows_sys::Win32::{
    Foundation::{ERROR_LOCK_VIOLATION, GENERIC_READ, GENERIC_WRITE},
    Storage::FileSystem::{
        CreateFileW, LockFileEx, UnlockFileEx, CREATE_NEW, FILE_FLAG_OPEN_REPARSE_POINT,
        FILE_READ_ATTRIBUTES, FILE_SHARE_READ, FILE_SHARE_WRITE, LOCKFILE_EXCLUSIVE_LOCK,
        LOCKFILE_FAIL_IMMEDIATELY, OPEN_EXISTING, READ_CONTROL,
    },
    System::IO::OVERLAPPED,
};

/// Retained genuine shared or exclusive byte-range lock beneath the exact original private root.
/// It is not a current credential, protected vault root or owner permit.
pub struct HeldPrivateWriterLease {
    root: Arc<PrivateDirectory>,
    file: File,
    identity: handles::Identity,
    name: String,
}
impl HeldPrivateWriterLease {
    /// Open/create the exact logical-name private lock file and acquire its genuine nonblocking OS lock.
    /// # Errors
    /// Refuses unsafe/nonprivate locks, contention and IO errors.
    pub fn exclusive(root: Arc<PrivateDirectory>, logical: &str) -> io::Result<Self> {
        Self::acquire(root, logical, LOCKFILE_EXCLUSIVE_LOCK)
    }
    /// Acquire an actual shared kernel byte-range lease beneath this same original private root.
    /// # Errors
    /// Refuses unsafe storage, an exclusive holder, substitution and IO failures.
    pub fn shared(root: Arc<PrivateDirectory>, logical: &str) -> io::Result<Self> {
        Self::acquire(root, logical, 0)
    }
    fn acquire(root: Arc<PrivateDirectory>, logical: &str, flags: u32) -> io::Result<Self> {
        root.validate()?;
        let name = physical_writer_lease_name(logical)?;
        let file = open(&root, &name)?;
        let identity = check(&root, &file, &name)?;
        let mut overlapped = OVERLAPPED::default();
        // SAFETY: actual live synchronous File and initialized byte offset zero.
        // Shared writer adapters must use this logical-name file and byte-zero range.
        if unsafe {
            LockFileEx(
                file.as_raw_handle(),
                flags | LOCKFILE_FAIL_IMMEDIATELY,
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
                .is_some_and(|value| u32::try_from(value) == Ok(ERROR_LOCK_VIOLATION))
            {
                return Err(io::Error::new(
                    io::ErrorKind::WouldBlock,
                    "the original private store is busy",
                ));
            }
            return Err(error);
        }
        let lock = Self {
            root,
            file,
            identity,
            name,
        };
        lock.validate()?;
        Ok(lock)
    }
    /// Recheck original root, owner/private lock identity while its OS lock remains held.
    /// # Errors
    /// Refuses changed physical state/ACL.
    pub fn validate(&self) -> io::Result<()> {
        if check(&self.root, &self.file, &self.name)? != self.identity {
            return Err(security::refused());
        }
        self.root.validate()
    }
}
impl Drop for HeldPrivateWriterLease {
    fn drop(&mut self) {
        let mut overlapped = OVERLAPPED::default();
        // SAFETY: this File still owns the exact byte-range lock at offset zero.
        // Closing its retained handle is the OS fallback if explicit release fails.
        unsafe {
            UnlockFileEx(self.file.as_raw_handle(), 0, 1, 0, &mut overlapped);
        }
    }
}
fn check(root: &PrivateDirectory, file: &File, name: &str) -> io::Result<handles::Identity> {
    root.validate()?;
    let identity = handles::identity(file, false)?;
    security::verify(file, &root.owner, false)?;
    handles::child_relation(root.root_handle()?, file, name)?;
    if file.metadata()?.len() != 0 {
        return Err(security::refused());
    }
    Ok(identity)
}
fn open(root: &PrivateDirectory, name: &str) -> io::Result<File> {
    let path = handles::wide(&root.path_for(Path::new(name))?)?;
    let descriptor = security::Descriptor::private(&root.owner, false)?;
    let attributes = descriptor.attributes()?;
    // SAFETY: actual bounded path, private descriptor and initialized attributes remain owned.
    let created = unsafe {
        CreateFileW(
            path.as_ptr(),
            GENERIC_READ | GENERIC_WRITE | READ_CONTROL | FILE_READ_ATTRIBUTES,
            FILE_SHARE_READ | FILE_SHARE_WRITE,
            &attributes,
            CREATE_NEW,
            FILE_FLAG_OPEN_REPARSE_POINT,
            ptr::null_mut(),
        )
    };
    match handles::owned(created) {
        Ok(file) => Ok(file),
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
            // SAFETY: existing node opened without following reparse points; no truncate/ACL repair.
            handles::owned(unsafe {
                CreateFileW(
                    path.as_ptr(),
                    GENERIC_READ | GENERIC_WRITE | READ_CONTROL | FILE_READ_ATTRIBUTES,
                    FILE_SHARE_READ | FILE_SHARE_WRITE,
                    ptr::null(),
                    OPEN_EXISTING,
                    FILE_FLAG_OPEN_REPARSE_POINT,
                    ptr::null_mut(),
                )
            })
        }
        Err(error) => Err(error),
    }
}

#[cfg(test)]
#[path = "writer_lease_tests.rs"]
mod tests;
