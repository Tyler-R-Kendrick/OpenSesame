//! Private original native root pins. This filesystem profile never authenticates a factor.
use opensesame_human_vault::root_protection::{KEY_FILE_NAME, MAX_MANIFEST_ENCODED_BYTES};
use sha2::{Digest, Sha256};
use std::ffi::CString;
use std::fs::{File, Metadata};
use std::io::{self, Read, Seek, SeekFrom};
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
}

pub(super) struct ScopedStore {
    key: File,
    lock: File,
    lock_name: CString,
    key_name: CString,
    key_metadata: Metadata,
    fingerprint: [u8; 32],
    directory: Directory,
}

fn private_regular(file: &File) -> io::Result<Metadata> {
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

fn unchanged(before: &Metadata, after: &Metadata) -> bool {
    before.dev() == after.dev()
        && before.ino() == after.ino()
        && before.len() == after.len()
        && before.mtime() == after.mtime()
        && before.mtime_nsec() == after.mtime_nsec()
        && before.ctime() == after.ctime()
        && before.ctime_nsec() == after.ctime_nsec()
}

fn read_bounded(file: &mut File) -> io::Result<Vec<u8>> {
    if file.metadata()?.len() > u64::try_from(MAX_MANIFEST_ENCODED_BYTES).map_err(|_| refused())? {
        return Err(refused());
    }
    file.seek(SeekFrom::Start(0))?;
    let mut bytes = Vec::new();
    file.take(u64::try_from(MAX_MANIFEST_ENCODED_BYTES + 1).map_err(|_| refused())?)
        .read_to_end(&mut bytes)?;
    if bytes.len() > MAX_MANIFEST_ENCODED_BYTES {
        return Err(refused());
    }
    Ok(bytes)
}

impl ScopedStore {
    pub(super) fn open(root: &Path) -> io::Result<(Self, Vec<u8>)> {
        let (directory, key_name) = Directory::pin(&root.join(KEY_FILE_NAME))?;
        let lock_name = name(crate::store_lock::STORE_LOCK_FILE.as_bytes())?;
        directory.validate()?;
        let lock = open_at(
            directory.root(),
            &lock_name,
            libc::O_RDWR | libc::O_CREAT | libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC,
        )?;
        if private_regular(&lock)?.len() != 0 {
            return Err(refused());
        }
        // SAFETY: this actual descriptor remains retained for the entire admission/commit.
        if unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
            return Err(io::Error::last_os_error());
        }
        directory.validate()?;
        if stat_at(
            directory.root(),
            &name(crate::rotation::ROTATION_STAGING_DIR.as_bytes())?,
        )?
        .is_some()
        {
            return Err(refused());
        }
        let mut key = open_at(
            directory.root(),
            &key_name,
            libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC,
        )?;
        let key_metadata = private_regular(&key)?;
        let bytes = read_bounded(&mut key)?;
        let fingerprint = Sha256::digest(&bytes).into();
        let mut opened = Self {
            directory,
            lock,
            lock_name,
            key,
            key_name,
            key_metadata,
            fingerprint,
        };
        opened.validate()?;
        Ok((opened, bytes))
    }

    pub(super) fn validate(&mut self) -> io::Result<()> {
        self.directory.validate()?;
        if stat_at(
            self.directory.root(),
            &name(crate::rotation::ROTATION_STAGING_DIR.as_bytes())?,
        )?
        .is_some()
        {
            return Err(refused());
        }
        let lock_entry = stat_at(self.directory.root(), &self.lock_name)?.ok_or_else(refused)?;
        let lock_metadata = private_regular(&self.lock)?;
        if !same(&lock_entry, &lock_metadata) || lock_metadata.len() != 0 {
            return Err(refused());
        }
        let key_entry = stat_at(self.directory.root(), &self.key_name)?.ok_or_else(refused)?;
        let current = private_regular(&self.key)?;
        if !same(&key_entry, &current) || !unchanged(&self.key_metadata, &current) {
            return Err(refused());
        }
        let actual: [u8; 32] = Sha256::digest(read_bounded(&mut self.key)?).into();
        if actual != self.fingerprint
            || !unchanged(&self.key_metadata, &private_regular(&self.key)?)
        {
            return Err(refused());
        }
        self.directory.validate()
    }
}

#[cfg(test)]
#[path = "storage_unix_tests.rs"]
mod tests;
