//! Generic original private encrypted-file DATA; never owner authentication.
use super::{name, open_at, refused, same, stat_at, PrivateDirectory};
use std::{
    ffi::CString,
    fs::{File, Metadata},
    io::{self, Read, Seek, SeekFrom},
    os::unix::{ffi::OsStrExt, fs::MetadataExt},
    path::{Component, Path},
    sync::Arc,
};
use zeroize::Zeroizing;

fn component(path: &Path) -> io::Result<CString> {
    let mut parts = path.components();
    let Some(Component::Normal(part)) = parts.next() else {
        return Err(refused());
    };
    if parts.next().is_some()
        || path.as_os_str().as_bytes() != part.as_bytes()
        || part.as_bytes().len() > 255
    {
        return Err(refused());
    }
    name(part.as_bytes())
}
fn private_file(file: &File) -> io::Result<Metadata> {
    let metadata = file.metadata()?;
    // SAFETY: geteuid has no pointer arguments.
    if !metadata.is_file()
        || metadata.nlink() != 1
        || metadata.mode() & 0o7777 != 0o600
        || metadata.uid() != unsafe { libc::geteuid() }
    {
        return Err(refused());
    }
    Ok(metadata)
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
fn read(file: &mut File, limit: usize) -> io::Result<Zeroizing<Vec<u8>>> {
    file.seek(SeekFrom::Start(0))?;
    let mut bytes = Zeroizing::new(Vec::new());
    Read::by_ref(file)
        .take(
            u64::try_from(limit)
                .map_err(|_| refused())?
                .saturating_add(1),
        )
        .read_to_end(&mut bytes)?;
    if bytes.len() > limit {
        return Err(refused());
    }
    Ok(bytes)
}

/// Actual retained nofollow private file snapshot under an original directory.
/// This carries encrypted DATA only; no password, root key, realm or owner verdict.
pub struct HeldPrivateRead {
    directory: Arc<PrivateDirectory>,
    component: CString,
    file: File,
    metadata: Metadata,
    bytes: Zeroizing<Vec<u8>>,
    limit: usize,
}
impl HeldPrivateRead {
    /// Read one bounded existing private leaf through the original retained root FD.
    /// # Errors
    /// Refuses aliases, broad/foreign/hardlinked nodes, changes, oversized data and IO failures.
    pub fn open(directory: Arc<PrivateDirectory>, leaf: &Path, limit: usize) -> io::Result<Self> {
        if limit == 0 || limit > 16 * 1024 * 1024 {
            return Err(refused());
        }
        directory.private_root()?;
        let component = component(leaf)?;
        let mut file = open_at(
            directory.root(),
            &component,
            libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK,
        )?;
        let metadata = private_file(&file)?;
        let entry = stat_at(directory.root(), &component)?.ok_or_else(refused)?;
        if !same(&entry, &metadata)
            || metadata.len() > u64::try_from(limit).map_err(|_| refused())?
        {
            return Err(refused());
        }
        let bytes = read(&mut file, limit)?;
        let mut held = Self {
            directory,
            component,
            file,
            metadata,
            bytes,
            limit,
        };
        held.validate()?;
        Ok(held)
    }
    /// Return this original encrypted snapshot. Consumers validate before using it.
    #[must_use]
    pub fn bytes(&self) -> &[u8] {
        &self.bytes
    }
    /// Validate original directory provenance, private file identity/version and exact bytes.
    /// # Errors
    /// Refuses a substituted root/leaf, in-place rewrite, profile change or read/IO failure.
    pub fn validate(&mut self) -> io::Result<()> {
        self.directory.private_root()?;
        let entry = stat_at(self.directory.root(), &self.component)?.ok_or_else(refused)?;
        let before = private_file(&self.file)?;
        if !same(&entry, &before) || !unchanged(&self.metadata, &before) {
            return Err(refused());
        }
        if *read(&mut self.file, self.limit)? != *self.bytes {
            return Err(refused());
        }
        if !unchanged(&before, &private_file(&self.file)?) {
            return Err(refused());
        }
        let after = stat_at(self.directory.root(), &self.component)?.ok_or_else(refused)?;
        if !same(&after, &self.metadata) {
            return Err(refused());
        }
        self.directory.private_root()
    }
}
#[cfg(test)]
#[path = "read_tests.rs"]
mod tests;
