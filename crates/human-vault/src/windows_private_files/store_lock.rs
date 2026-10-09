//! Genuine original private store kernel locking; this proves no credential authority.
use super::{handles, security, PrivateDirectory};
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
const NAME: &str = ".opensesame-lock";
const ROTATION: &str = ".opensesame-rotation";

/// Retained exclusive byte-range lock beneath the exact original private root.
/// It is not a current credential, protected vault root or owner permit.
pub struct HeldPrivateStoreLock {
    root: Arc<PrivateDirectory>,
    file: File,
    identity: handles::Identity,
}
impl HeldPrivateStoreLock {
    /// Open/create the fixed private lock file and acquire its genuine nonblocking OS lock.
    /// # Errors
    /// Refuses unsafe/nonprivate locks, rotation staging, contention and IO errors.
    pub fn exclusive(root: Arc<PrivateDirectory>) -> io::Result<Self> {
        root.validate()?;
        no_rotation(&root)?;
        let file = open(&root)?;
        let identity = check(&root, &file)?;
        let mut overlapped = OVERLAPPED::default();
        // SAFETY: actual live synchronous File and initialized byte offset zero.
        // The range matches ordinary native StoreLock and remains held by this File.
        if unsafe {
            LockFileEx(
                file.as_raw_handle(),
                LOCKFILE_EXCLUSIVE_LOCK | LOCKFILE_FAIL_IMMEDIATELY,
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
        };
        lock.validate()?;
        Ok(lock)
    }
    /// Recheck original root, owner/private lock identity and staging while its OS lock remains held.
    /// # Errors
    /// Refuses changed physical state/ACL or observed rotation staging.
    pub fn validate(&self) -> io::Result<()> {
        if check(&self.root, &self.file)? != self.identity {
            return Err(security::refused());
        }
        no_rotation(&self.root)
    }
}
impl Drop for HeldPrivateStoreLock {
    fn drop(&mut self) {
        let mut overlapped = OVERLAPPED::default();
        // SAFETY: this File still owns the exact byte-range lock at offset zero.
        // Closing its retained handle is the OS fallback if explicit release fails.
        unsafe {
            UnlockFileEx(self.file.as_raw_handle(), 0, 1, 0, &mut overlapped);
        }
    }
}
fn check(root: &PrivateDirectory, file: &File) -> io::Result<handles::Identity> {
    root.validate()?;
    let identity = handles::identity(file, false)?;
    security::verify(file, &root.owner, false)?;
    handles::child_relation(root.root_handle()?, file, NAME)?;
    if file.metadata()?.len() != 0 {
        return Err(security::refused());
    }
    Ok(identity)
}
fn open(root: &PrivateDirectory) -> io::Result<File> {
    let path = handles::wide(&root.path_for(Path::new(NAME))?)?;
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
fn no_rotation(root: &PrivateDirectory) -> io::Result<()> {
    root.validate()?;
    let path = root.path_for(Path::new(ROTATION))?;
    match std::fs::symlink_metadata(path) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        _ => Err(security::refused()),
    }
}
