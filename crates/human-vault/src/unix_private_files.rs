//! Retained Unix private directory provenance; never owner/factor authentication.
use std::ffi::CString;
use std::fs::{File, Metadata};
use std::io;
use std::os::fd::{AsRawFd, FromRawFd};
use std::os::unix::{
    ffi::OsStrExt,
    fs::{MetadataExt, OpenOptionsExt},
};
use std::path::{Component, Path};

fn refused() -> io::Error {
    io::Error::new(
        io::ErrorKind::PermissionDenied,
        "private file path changed or is unsafe",
    )
}

fn name(bytes: &[u8]) -> io::Result<CString> {
    CString::new(bytes).map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "NUL in file path"))
}

fn open_at(parent: &File, name: &CString, flags: libc::c_int) -> io::Result<File> {
    // SAFETY: the live descriptor and NUL-terminated name are retained for the call.
    let fd = unsafe { libc::openat(parent.as_raw_fd(), name.as_ptr(), flags, 0o600) };
    if fd < 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: successful openat supplies a new descriptor owned solely by this File.
    Ok(unsafe { File::from_raw_fd(fd) })
}

fn stat_at(parent: &File, name: &CString) -> io::Result<Option<libc::stat>> {
    let mut stat = std::mem::MaybeUninit::<libc::stat>::uninit();
    // SAFETY: stat points to writable storage; descriptors and name remain valid.
    let result = unsafe {
        libc::fstatat(
            parent.as_raw_fd(),
            name.as_ptr(),
            stat.as_mut_ptr(),
            libc::AT_SYMLINK_NOFOLLOW,
        )
    };
    if result == 0 {
        // SAFETY: fstatat initialized the complete stat on success.
        Ok(Some(unsafe { stat.assume_init() }))
    } else {
        let error = io::Error::last_os_error();
        if error.raw_os_error() == Some(libc::ENOENT) {
            Ok(None)
        } else {
            Err(error)
        }
    }
}

// libc dev_t/ino_t differ across supported Unix targets; reject unrepresentable values.
fn unsigned<T: TryInto<u64>>(value: T) -> Option<u64> {
    value.try_into().ok()
}

fn same(stat: &libc::stat, metadata: &Metadata) -> bool {
    unsigned(stat.st_dev) == Some(metadata.dev()) && unsigned(stat.st_ino) == Some(metadata.ino())
}

// Android app-private paths can have searchable, non-readable OS ancestors.
// O_PATH still supplies a retained descriptor for fstat/openat/fstatat. The actual
// vault root stays readable because publication requires real directory fsync.
fn directory_flags(readable: bool) -> libc::c_int {
    #[cfg(target_os = "android")]
    let access = if readable {
        libc::O_RDONLY
    } else {
        libc::O_PATH
    };
    #[cfg(not(target_os = "android"))]
    let access = {
        let _ = readable;
        libc::O_RDONLY
    };
    access | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC
}

pub struct PrivateDirectory {
    files: Vec<File>,
    names: Vec<CString>,
    private_start: usize,
    #[cfg(any(target_os = "macos", target_os = "ios"))]
    aliases: Vec<(CString, libc::stat)>,
}

impl PrivateDirectory {
    fn pin(path: &Path) -> io::Result<(Self, CString)> {
        let (pinned, leaf) = Self::pin_entries(path)?;
        pinned.validate()?;
        Ok((pinned, leaf))
    }

    // Internal resource walker; ordinary callers must additionally validate the final root.
    fn pin_entries(path: &Path) -> io::Result<(Self, CString)> {
        let absolute = std::path::absolute(path)?;
        if absolute.as_os_str().as_bytes().len() > 4096 || absolute.components().count() > 128 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "private file path exceeds limits",
            ));
        }
        let leaf = absolute.file_name().ok_or_else(refused)?;
        let leaf = name(leaf.as_bytes())?;
        let parent = absolute.parent().ok_or_else(refused)?;
        let root = File::options()
            .read(true)
            .custom_flags(directory_flags(false))
            .open("/")?;
        let mut pinned = Self {
            files: vec![root],
            names: Vec::new(),
            private_start: 0,
            #[cfg(any(target_os = "macos", target_os = "ios"))]
            aliases: Vec::new(),
        };
        let final_component = parent.components().count().saturating_sub(1);
        for (index, component) in parent.components().enumerate() {
            match component {
                Component::RootDir => {}
                Component::Normal(part) => {
                    let part = name(part.as_bytes())?;
                    #[cfg(any(target_os = "macos", target_os = "ios"))]
                    pinned.pin_os_alias(&part)?;
                    let child = open_at(
                        pinned.root(),
                        &part,
                        directory_flags(index == final_component),
                    )?;
                    pinned.names.push(part);
                    pinned.files.push(child);
                }
                _ => return Err(refused()),
            }
        }
        pinned.private_start = pinned.files.len().checked_sub(1).ok_or_else(refused)?;
        pinned.validate_entries()?;
        Ok((pinned, leaf))
    }

    #[cfg(any(target_os = "macos", target_os = "ios"))]
    fn pin_os_alias(&mut self, part: &CString) -> io::Result<()> {
        if !self.names.is_empty() || !matches!(part.to_bytes(), b"tmp" | b"var") {
            return Ok(());
        }
        let Some(stat) = stat_at(self.root(), part)? else {
            return Ok(());
        };
        if stat.st_mode & libc::S_IFMT != libc::S_IFLNK {
            return Ok(());
        }
        self.validate_os_alias(part, &stat)?;
        self.aliases.push((part.clone(), stat));
        let private = name(b"private")?;
        let directory = open_at(
            self.root(),
            &private,
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        )?;
        self.names.push(private);
        self.files.push(directory);
        Ok(())
    }

    fn root(&self) -> &File {
        &self.files[self.files.len() - 1]
    }

    #[cfg(any(target_os = "macos", target_os = "ios"))]
    fn validate_os_alias(&self, alias: &CString, original: &libc::stat) -> io::Result<()> {
        let actual = stat_at(&self.files[0], alias)?.ok_or_else(refused)?;
        let mut target = [0u8; 32];
        // SAFETY: valid root descriptor, component and writable bounded buffer.
        let count = unsafe {
            libc::readlinkat(
                self.files[0].as_raw_fd(),
                alias.as_ptr(),
                target.as_mut_ptr().cast(),
                target.len(),
            )
        };
        let count = usize::try_from(count).map_err(|_| refused())?;
        let expected = [b"private/".as_slice(), alias.to_bytes()].concat();
        let absolute_expected = [b"/".as_slice(), expected.as_slice()].concat();
        if actual.st_uid != 0
            || actual.st_mode & libc::S_IFMT != libc::S_IFLNK
            || actual.st_dev != original.st_dev
            || actual.st_ino != original.st_ino
            || (target.get(..count) != Some(expected.as_slice())
                && target.get(..count) != Some(absolute_expected.as_slice()))
        {
            return Err(refused());
        }
        let root = self.files[0].metadata()?;
        if root.uid() != 0 || root.mode() & 0o022 != 0 {
            return Err(refused());
        }
        Ok(())
    }

    fn validate_entries(&self) -> io::Result<()> {
        #[cfg(any(target_os = "macos", target_os = "ios"))]
        for (alias, original) in &self.aliases {
            self.validate_os_alias(alias, original)?;
        }
        for (index, part) in self.names.iter().enumerate() {
            let actual = stat_at(&self.files[index], part)?.ok_or_else(refused)?;
            if !same(&actual, &self.files[index + 1].metadata()?)
                || actual.st_mode & libc::S_IFMT != libc::S_IFDIR
            {
                return Err(refused());
            }
        }
        Ok(())
    }

    fn validate(&self) -> io::Result<()> {
        self.validate_entries()?;
        let root = self.root().metadata()?;
        // SAFETY: geteuid takes no pointers and returns the current effective user.
        if root.uid() != unsafe { libc::geteuid() } || root.mode() & 0o022 != 0 {
            return Err(refused());
        }
        Ok(())
    }
}

impl PrivateDirectory {
    /// Create one new private final root under existing original pinned ancestors.
    /// This physical operation grants no password or vault-owner authority.
    /// # Errors
    /// Refuses existing roots, aliases, non-private writable parents and IO failures.
    /// A newly created empty private directory can remain after a later failed check.
    pub fn create_new(root: &Path) -> io::Result<Self> {
        let (mut parent, component) = Self::pin(root)?;
        parent.validate()?;
        // SAFETY: parent and component remain retained; mkdirat creates only this leaf.
        if unsafe { libc::mkdirat(parent.root().as_raw_fd(), component.as_ptr(), 0o700) } < 0 {
            return Err(io::Error::last_os_error());
        }
        let child = open_at(parent.root(), &component, directory_flags(true))?;
        let original = stat_at(parent.root(), &component)?.ok_or_else(refused)?;
        if !same(&original, &child.metadata()?) {
            return Err(refused());
        }
        parent.names.push(component);
        parent.files.push(child);
        parent.private_start = parent.files.len().checked_sub(1).ok_or_else(refused)?;
        parent.private_root()?;
        parent.root().sync_all()?;
        parent.private_root()?;
        Ok(parent)
    }

    /// Open an existing exact owner-private root without permission changes.
    /// # Errors
    /// Refuses unsafe original ancestors, root permissions and IO errors.
    pub fn open(root: &Path) -> io::Result<Self> {
        let (held, _) = Self::pin(&root.join(".physical-root-proof"))?;
        held.private_root()?;
        Ok(held)
    }

    fn private_root(&self) -> io::Result<()> {
        self.validate()?;
        let private = self.files.get(self.private_start..).ok_or_else(refused)?;
        if private.is_empty() {
            return Err(refused());
        }
        for original in private {
            let metadata = original.metadata()?;
            // SAFETY: geteuid takes no pointer arguments.
            if !metadata.is_dir()
                || metadata.mode() & 0o7777 != 0o700
                || metadata.uid() != unsafe { libc::geteuid() }
            {
                return Err(refused());
            }
        }
        Ok(())
    }
}

#[path = "unix_private_files/write_new.rs"]
mod write_new;
pub use write_new::write_new;
#[cfg(test)]
#[path = "unix_private_files/tests.rs"]
mod tests;

#[cfg(target_os = "android")]
#[path = "unix_private_files/android_app_parent.rs"]
mod android_app_parent;

#[path = "unix_private_files/read.rs"]
mod read;
pub use read::HeldPrivateRead;

#[path = "unix_private_files/writer_lease.rs"]
mod writer_lease;
pub use writer_lease::HeldPrivateWriterLease;

#[path = "unix_private_files/child.rs"]
mod child;
#[path = "unix_private_files/directory_inventory.rs"]
mod directory_inventory;
