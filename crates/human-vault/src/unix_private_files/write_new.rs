//! Exact retained-root create-new publication; private mode precedes bytes.
use super::*;
use std::io::{Read, Seek, SeekFrom, Write};

struct Pending<'a> {
    directory: &'a PrivateDirectory,
    component: CString,
    file: File,
    committed: bool,
}
impl Drop for Pending<'_> {
    fn drop(&mut self) {
        if self.committed {
            return;
        }
        let same_created = self
            .file
            .metadata()
            .ok()
            .and_then(|metadata| {
                stat_at(self.directory.root(), &self.component)
                    .ok()
                    .flatten()
                    .map(|stat| same(&stat, &metadata))
            })
            .unwrap_or(false);
        if same_created {
            // SAFETY: relative original root FD; only the exact created inode is selected.
            unsafe {
                libc::unlinkat(
                    self.directory.root().as_raw_fd(),
                    self.component.as_ptr(),
                    0,
                );
            }
        }
    }
}
fn private_file(file: &File) -> io::Result<Metadata> {
    let metadata = file.metadata()?;
    // SAFETY: effective UID query has no pointer arguments.
    if !metadata.is_file()
        || metadata.nlink() != 1
        || metadata.mode() & 0o7777 != 0o600
        || metadata.uid() != unsafe { libc::geteuid() }
    {
        return Err(refused());
    }
    Ok(metadata)
}

/// Write a new bounded private leaf through the actual retained root descriptor.
/// # Errors
/// Refuses existing leaves, path aliases, broad profiles, mismatched final bytes or IO failures.
/// A final acknowledgment error after publication does not claim rollback of committed bytes.
pub fn write_new(directory: &PrivateDirectory, leaf: &Path, bytes: &[u8]) -> io::Result<()> {
    directory.private_root()?;
    let mut components = leaf.components();
    let Some(Component::Normal(part)) = components.next() else {
        return Err(refused());
    };
    if components.next().is_some()
        || part.as_bytes().is_empty()
        || leaf.as_os_str().as_bytes() != part.as_bytes()
        || bytes.len() > 4 * 1024 * 1024
    {
        return Err(refused());
    }
    let component = name(part.as_bytes())?;
    let file = open_at(
        directory.root(),
        &component,
        libc::O_RDWR | libc::O_CREAT | libc::O_EXCL | libc::O_NOFOLLOW | libc::O_CLOEXEC,
    )?;
    let mut pending = Pending {
        directory,
        component,
        file,
        committed: false,
    };
    let before = private_file(&pending.file)?;
    directory.private_root()?;
    pending.file.write_all(bytes)?;
    pending.file.sync_all()?;
    let actual = stat_at(directory.root(), &pending.component)?.ok_or_else(refused)?;
    if !same(&actual, &before) || !same(&actual, &private_file(&pending.file)?) {
        return Err(refused());
    }
    pending.file.seek(SeekFrom::Start(0))?;
    let mut acknowledged = Vec::new();
    Read::by_ref(&mut pending.file)
        .take(
            u64::try_from(bytes.len())
                .map_err(|_| refused())?
                .saturating_add(1),
        )
        .read_to_end(&mut acknowledged)?;
    if acknowledged != bytes {
        return Err(refused());
    }
    directory.private_root()?;
    directory.root().sync_all()?;
    directory.private_root()?;
    pending.committed = true;
    Ok(())
}
