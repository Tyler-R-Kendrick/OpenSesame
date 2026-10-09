//! Actual bounded enumeration from retained original Unix directory FDs, never paths/revision metadata.
use super::{directory_flags, name, open_at, refused, stat_at, PrivateDirectory};
use std::collections::BTreeSet;
use std::os::fd::IntoRawFd;
use std::{
    ffi::CString,
    fs::{File, Metadata},
    io,
    os::{fd::FromRawFd, unix::fs::MetadataExt},
};
struct Stream(*mut libc::DIR);
impl Drop for Stream {
    fn drop(&mut self) {
        // SAFETY: fdopendir created the exclusively owned live stream; closed exactly once.
        unsafe {
            libc::closedir(self.0);
        }
    }
}
#[cfg(any(
    target_os = "linux",
    target_os = "android",
    target_os = "macos",
    target_os = "ios"
))]
fn next(stream: &Stream) -> io::Result<Option<CString>> {
    // SAFETY: libc supplies this thread's live errno slot and stream remains exclusively owned.
    unsafe {
        #[cfg(target_os = "linux")]
        let error_slot = libc::__errno_location();
        #[cfg(target_os = "android")]
        let error_slot = libc::__errno();
        #[cfg(any(target_os = "macos", target_os = "ios"))]
        let error_slot = libc::__error();
        *error_slot = 0;
        let entry = libc::readdir(stream.0);
        if entry.is_null() {
            return if *error_slot == 0 {
                Ok(None)
            } else {
                Err(io::Error::last_os_error())
            };
        }
        Ok(Some(
            std::ffi::CStr::from_ptr((*entry).d_name.as_ptr()).to_owned(),
        ))
    }
}
#[cfg(not(any(
    target_os = "linux",
    target_os = "android",
    target_os = "macos",
    target_os = "ios"
)))]
fn next(_stream: &Stream) -> io::Result<Option<CString>> {
    Err(refused())
}
fn unchanged(a: &Metadata, b: &Metadata) -> bool {
    a.dev() == b.dev()
        && a.ino() == b.ino()
        && a.len() == b.len()
        && a.mtime() == b.mtime()
        && a.mtime_nsec() == b.mtime_nsec()
        && a.ctime() == b.ctime()
        && a.ctime_nsec() == b.ctime_nsec()
}
impl PrivateDirectory {
    /// Enumerate actual bounded children from an independent description of this original root.
    /// File and directory names are physical DATA, never a credential or owner verdict.
    /// # Errors
    /// Refuses changed root/version, unknown node types, invalid UTF8/names and entry budgets.
    pub fn original_bounded_directory_entries(
        &self,
        maximum: usize,
    ) -> io::Result<Vec<(String, bool)>> {
        if maximum == 0 || maximum > 4096 {
            return Err(refused());
        }
        self.private_root()?;
        let before = self.root().metadata()?;
        let reader = open_at(self.root(), &name(b".")?, directory_flags(true))?;
        if !unchanged(&before, &reader.metadata()?) {
            return Err(refused());
        }
        let raw = reader.into_raw_fd();
        // SAFETY: fdopendir takes ownership of this independent live directory FD only on success.
        let stream = unsafe { libc::fdopendir(raw) };
        if stream.is_null() {
            let error = io::Error::last_os_error();
            // SAFETY: failed fdopendir left ownership with the caller.
            drop(unsafe { File::from_raw_fd(raw) });
            return Err(error);
        }
        let stream = Stream(stream);
        let mut result = Vec::new();
        let mut seen = BTreeSet::new();
        while let Some(component) = next(&stream)? {
            if matches!(component.to_bytes(), b"." | b"..") {
                continue;
            }
            if component.to_bytes().len() > 255 || !seen.insert(component.clone()) {
                return Err(refused());
            }
            let text = component.to_str().map_err(|_| refused())?.to_owned();
            let observed = stat_at(self.root(), &component)?.ok_or_else(refused)?;
            let directory = observed.st_mode & libc::S_IFMT == libc::S_IFDIR;
            if !directory && observed.st_mode & libc::S_IFMT != libc::S_IFREG {
                return Err(refused());
            }
            result.push((text, directory));
            if result.len() > maximum {
                return Err(refused());
            }
        }
        if !unchanged(&before, &self.root().metadata()?) {
            return Err(refused());
        }
        self.private_root()?;
        result.sort();
        Ok(result)
    }
}
#[cfg(test)]
#[path = "directory_inventory_tests.rs"]
mod tests;
