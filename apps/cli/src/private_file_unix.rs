//! Descriptor-relative private publication. Filesystem confinement is not authentication.
use std::ffi::CString;
use std::fs::{File, Metadata};
use std::io::{self, Write};
use std::os::fd::{AsRawFd, FromRawFd};
use std::os::unix::{ffi::OsStrExt, fs::MetadataExt};
use std::path::{Component, Path};

pub(crate) fn write_private(path: &Path, bytes: &[u8]) -> anyhow::Result<()> {
    publish(path, false, |file| file.write_all(bytes))?;
    Ok(())
}

pub(crate) fn write_private_new(path: &Path, bytes: &[u8]) -> anyhow::Result<()> {
    publish(path, true, |file| file.write_all(bytes))?;
    Ok(())
}

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

struct Directory {
    files: Vec<File>,
    names: Vec<CString>,
    #[cfg(target_os = "macos")]
    aliases: Vec<(CString, libc::stat)>,
}

impl Directory {
    fn pin(path: &Path) -> io::Result<(Self, CString)> {
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
            .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
            .open("/")?;
        let mut pinned = Self {
            files: vec![root],
            names: Vec::new(),
            #[cfg(target_os = "macos")]
            aliases: Vec::new(),
        };
        for component in parent.components() {
            match component {
                Component::RootDir => {}
                Component::Normal(part) => {
                    let part = name(part.as_bytes())?;
                    #[cfg(target_os = "macos")]
                    pinned.pin_os_alias(&part)?;
                    let child = open_at(
                        pinned.root(),
                        &part,
                        libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
                    )?;
                    pinned.names.push(part);
                    pinned.files.push(child);
                }
                _ => return Err(refused()),
            }
        }
        pinned.validate()?;
        Ok((pinned, leaf))
    }

    #[cfg(target_os = "macos")]
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

    #[cfg(target_os = "macos")]
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

    fn validate(&self) -> io::Result<()> {
        #[cfg(target_os = "macos")]
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
        let root = self.root().metadata()?;
        // SAFETY: geteuid takes no pointers and returns the current effective user.
        if root.uid() != unsafe { libc::geteuid() } || root.mode() & 0o022 != 0 {
            return Err(refused());
        }
        Ok(())
    }

    fn inspect_destination(&self, leaf: &CString) -> io::Result<()> {
        if let Some(stat) = stat_at(self.root(), leaf)? {
            // A broad ordinary file can be replaced, but no linked target is written through.
            if stat.st_mode & libc::S_IFMT != libc::S_IFREG || stat.st_nlink != 1 {
                return Err(refused());
            }
        }
        Ok(())
    }
}

use std::os::unix::fs::OpenOptionsExt;

struct Pending<'a> {
    dir: &'a Directory,
    name: CString,
    file: File,
    published: bool,
}

impl Pending<'_> {
    fn validate(&self) -> io::Result<()> {
        self.dir.validate()?;
        let stat = stat_at(self.dir.root(), &self.name)?.ok_or_else(refused)?;
        let metadata = self.file.metadata()?;
        // SAFETY: geteuid takes no pointers.
        if !same(&stat, &metadata)
            || !metadata.is_file()
            || metadata.nlink() != 1
            || metadata.mode() & 0o777 != 0o600
            || metadata.uid() != unsafe { libc::geteuid() }
        {
            return Err(refused());
        }
        Ok(())
    }
}

impl Drop for Pending<'_> {
    fn drop(&mut self) {
        if !self.published {
            let original = self.file.metadata().ok();
            let current = stat_at(self.dir.root(), &self.name).ok().flatten();
            if original
                .as_ref()
                .zip(current.as_ref())
                .is_some_and(|(original, current)| same(current, original))
            {
                // SAFETY: remove only our still-matching entry under the held directory.
                unsafe {
                    libc::unlinkat(self.dir.root().as_raw_fd(), self.name.as_ptr(), 0);
                }
            }
        }
    }
}

fn publish(
    path: &Path,
    exclusive: bool,
    populate: impl FnOnce(&mut File) -> io::Result<()>,
) -> io::Result<()> {
    let (dir, leaf) = Directory::pin(path)?;
    dir.inspect_destination(&leaf)?;
    let temporary =
        name(format!(".opensesame-private-{:032x}.tmp", rand::random::<u128>()).as_bytes())?;
    let file = open_at(
        dir.root(),
        &temporary,
        libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_NOFOLLOW | libc::O_CLOEXEC,
    )?;
    let mut pending = Pending {
        dir: &dir,
        name: temporary,
        file,
        published: false,
    };
    // SAFETY: fchmod changes this exclusively created, retained file, never a pathname.
    if unsafe { libc::fchmod(pending.file.as_raw_fd(), 0o600) } < 0 {
        return Err(io::Error::last_os_error());
    }
    pending.validate()?;
    populate(&mut pending.file)?;
    pending.validate()?;
    pending.file.sync_all()?;
    dir.inspect_destination(&leaf)?;
    pending.validate()?;
    // SAFETY: both names are bounded components of the same retained directory.
    let result = unsafe {
        if exclusive {
            libc::linkat(
                dir.root().as_raw_fd(),
                pending.name.as_ptr(),
                dir.root().as_raw_fd(),
                leaf.as_ptr(),
                0,
            )
        } else {
            libc::renameat(
                dir.root().as_raw_fd(),
                pending.name.as_ptr(),
                dir.root().as_raw_fd(),
                leaf.as_ptr(),
            )
        }
    };
    if result < 0 {
        return Err(io::Error::last_os_error());
    }
    if exclusive {
        // SAFETY: the temporary entry is ours; final publication remains intact on failure.
        if unsafe { libc::unlinkat(dir.root().as_raw_fd(), pending.name.as_ptr(), 0) } < 0 {
            return Err(io::Error::last_os_error());
        }
    }
    pending.published = true;
    // Publication can have committed when a following check/fsync fails; no rollback promise.
    dir.root().sync_all()?;
    dir.validate()?;
    let actual = stat_at(dir.root(), &leaf)?.ok_or_else(refused)?;
    if !same(&actual, &pending.file.metadata()?) || actual.st_nlink != 1 {
        return Err(refused());
    }
    Ok(())
}

#[cfg(test)]
#[path = "private_file_unix_tests.rs"]
mod tests;
