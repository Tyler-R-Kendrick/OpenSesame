//! Actual original-root flock writer lease; physical serialization is never owner proof.
use super::{name, open_at, refused, same, stat_at, PrivateDirectory};
use crate::root_protection::physical_writer_lease::physical_writer_lease_name;
use std::{
    ffi::CString,
    fs::{File, Metadata},
    io,
    os::{fd::AsRawFd, unix::fs::MetadataExt},
    sync::Arc,
};
fn private_lock(file: &File) -> io::Result<Metadata> {
    let metadata = file.metadata()?;
    // SAFETY: geteuid has no pointer arguments.
    if !metadata.is_file()
        || metadata.nlink() != 1
        || metadata.len() != 0
        || metadata.mode() & 0o7777 != 0o600
        || metadata.uid() != unsafe { libc::geteuid() }
    {
        return Err(refused());
    }
    Ok(metadata)
}
fn check(directory: &PrivateDirectory, component: &CString, file: &File) -> io::Result<()> {
    directory.private_root()?;
    let actual = stat_at(directory.root(), component)?.ok_or_else(refused)?;
    if !same(&actual, &private_lock(file)?) {
        return Err(refused());
    }
    directory.private_root()
}
/// Opaque actual kernel writer lock, retained until drop. No password/realm/root is returned.
pub struct HeldPrivateWriterLease {
    directory: Arc<PrivateDirectory>,
    component: CString,
    file: File,
    mode: libc::c_int,
}
impl HeldPrivateWriterLease {
    /// Acquire the exact logical-name shared native protocol through this original root.
    /// Uses nonblocking flock; caller queueing must preserve its original root and cancellation.
    /// # Errors
    /// Refuses unsafe root/file profiles, substituted lock files, contention and IO failures.
    pub fn exclusive(directory: Arc<PrivateDirectory>, logical: &str) -> io::Result<Self> {
        Self::acquire(directory, logical, libc::LOCK_EX)
    }
    /// Acquire an actual shared flock reader lease under the identical original-root protocol.
    /// # Errors
    /// Refuses unsafe storage, an exclusive holder, substitution and IO failures.
    pub fn shared(directory: Arc<PrivateDirectory>, logical: &str) -> io::Result<Self> {
        Self::acquire(directory, logical, libc::LOCK_SH)
    }
    fn acquire(
        directory: Arc<PrivateDirectory>,
        logical: &str,
        flags: libc::c_int,
    ) -> io::Result<Self> {
        directory.private_root()?;
        let physical = physical_writer_lease_name(logical)?;
        let component = name(physical.as_bytes())?;
        let file = open_at(
            directory.root(),
            &component,
            libc::O_RDWR | libc::O_CREAT | libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK,
        )?;
        check(&directory, &component, &file)?;
        // SAFETY: actual owned live lock FD; nonblocking flock of the actual requested mode persists on this file description.
        if unsafe { libc::flock(file.as_raw_fd(), flags | libc::LOCK_NB) } != 0 {
            return Err(io::Error::last_os_error());
        }
        let held = Self {
            directory,
            component,
            file,
            mode: flags,
        };
        held.validate()?;
        Ok(held)
    }
    pub(crate) fn validate_exclusive_for(
        &self,
        original: &Arc<PrivateDirectory>,
        logical: &str,
    ) -> io::Result<()> {
        self.validate()?;
        if self.mode != libc::LOCK_EX
            || !Arc::ptr_eq(&self.directory, original)
            || self.component.to_bytes() != physical_writer_lease_name(logical)?.as_bytes()
        {
            return Err(refused());
        }
        Ok(())
    }
    /// Revalidate retained original ancestry and exact private locked file without reopening it.
    /// # Errors
    /// Refuses replacement, permission/owner/nlink/content changes or original-root substitution.
    pub fn validate(&self) -> io::Result<()> {
        check(&self.directory, &self.component, &self.file)
    }
}
impl Drop for HeldPrivateWriterLease {
    fn drop(&mut self) {
        // SAFETY: actual owned live FD; final close is the OS release fallback.
        unsafe {
            libc::flock(self.file.as_raw_fd(), libc::LOCK_UN);
        }
    }
}
#[cfg(test)]
#[path = "writer_lease_tests.rs"]
mod tests;
