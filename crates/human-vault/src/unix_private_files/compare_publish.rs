//! Exact-byte publication under the private actor's real ordered leases. No authentication grant.
#[cfg(test)]
use super::write_new;
use super::{name, open_at, refused, same, stat_at, HeldPrivateRead, PrivateDirectory};
use std::{
    ffi::CString,
    fs::File,
    io,
    os::{
        fd::AsRawFd,
        unix::{ffi::OsStrExt, fs::MetadataExt},
    },
    path::{Component, Path},
};
use std::{io::Write, sync::Arc};
const LIMIT: usize = 16 * 1024 * 1024;
struct Stage<'a> {
    directory: &'a PrivateDirectory,
    component: CString,
    file: File,
    published: bool,
}
impl Stage<'_> {
    fn check(&self) -> io::Result<()> {
        self.directory.private_root()?;
        let metadata = self.file.metadata()?;
        let actual = stat_at(self.directory.root(), &self.component)?.ok_or_else(refused)?;
        // SAFETY: effective UID query takes no pointer arguments.
        if !same(&actual, &metadata)
            || !metadata.is_file()
            || metadata.nlink() != 1
            || metadata.mode() & 0o7777 != 0o600
            || metadata.uid() != unsafe { libc::geteuid() }
        {
            return Err(refused());
        }
        Ok(())
    }
}
impl Drop for Stage<'_> {
    fn drop(&mut self) {
        if self.published {
            return;
        }
        let exact = self
            .file
            .metadata()
            .ok()
            .and_then(|metadata| {
                stat_at(self.directory.root(), &self.component)
                    .ok()
                    .flatten()
                    .map(|actual| same(&actual, &metadata))
            })
            .unwrap_or(false);
        if exact {
            // SAFETY: retained original directory and exact created inode identity select our stage only.
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
fn component(leaf: &Path) -> io::Result<CString> {
    let mut parts = leaf.components();
    let Some(Component::Normal(part)) = parts.next() else {
        return Err(refused());
    };
    if parts.next().is_some()
        || part.as_bytes().len() > 255
        || part.as_bytes() != leaf.as_os_str().as_bytes()
    {
        return Err(refused());
    }
    name(part.as_bytes())
}
fn expected_bytes(
    directory: &Arc<PrivateDirectory>,
    leaf: &Path,
    expected: Option<&[u8]>,
) -> io::Result<()> {
    match HeldPrivateRead::open(Arc::clone(directory), leaf, LIMIT) {
        Ok(mut held) => {
            held.validate()?;
            if expected != Some(held.bytes()) {
                return Err(refused());
            }
            held.validate()
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound && expected.is_none() => Ok(()),
        Err(error) => Err(error),
    }
}
fn rename_stage(
    directory: &PrivateDirectory,
    stages: &PrivateDirectory,
    stage: &CString,
    target: &CString,
    replace: bool,
) -> io::Result<()> {
    let from = stages.root().as_raw_fd();
    let to = directory.root().as_raw_fd();
    if !replace {
        return rename_absent(from, stage, to, target);
    }
    // SAFETY: retained original source/target FDs and terminated relative names remain live.
    let result = unsafe { libc::renameat(from, stage.as_ptr(), to, target.as_ptr()) };
    if result != 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}
#[cfg(any(
    target_os = "linux",
    target_os = "android",
    target_os = "macos",
    target_os = "ios"
))]
fn rename_absent(
    from: libc::c_int,
    stage: &CString,
    to: libc::c_int,
    target: &CString,
) -> io::Result<()> {
    #[cfg(target_os = "android")]
    let flags = libc::c_uint::try_from(libc::RENAME_NOREPLACE).map_err(|_| refused())?;
    #[cfg(target_os = "linux")]
    let flags = libc::RENAME_NOREPLACE;
    // SAFETY: live owned original directory FDs and terminated relative names; no-overwrite kernel rename.
    let result = unsafe {
        #[cfg(any(target_os = "linux", target_os = "android"))]
        {
            libc::renameat2(from, stage.as_ptr(), to, target.as_ptr(), flags)
        }
        #[cfg(any(target_os = "macos", target_os = "ios"))]
        {
            libc::renameatx_np(from, stage.as_ptr(), to, target.as_ptr(), libc::RENAME_EXCL)
        }
    };
    if result != 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}
#[cfg(not(any(
    target_os = "linux",
    target_os = "android",
    target_os = "macos",
    target_os = "ios"
)))]
fn rename_absent(
    _from: libc::c_int,
    _stage: &CString,
    _to: libc::c_int,
    _target: &CString,
) -> io::Result<()> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "native no-overwrite publication is unavailable",
    ))
}
fn stage_budget(stages: &PrivateDirectory) -> io::Result<()> {
    let entries = stages.original_bounded_directory_entries(64)?;
    if entries.len() >= 64 {
        return Err(refused());
    }
    for (name, is_directory) in entries {
        let suffix = name
            .strip_prefix(".opensesame-data-stage-")
            .ok_or_else(refused)?;
        let id = uuid::Uuid::parse_str(suffix).map_err(|_| refused())?;
        if is_directory || id.to_string() != suffix {
            return Err(refused());
        }
    }
    Ok(())
}
fn acknowledge(
    directory: &Arc<PrivateDirectory>,
    leaf: &Path,
    bytes: Option<&[u8]>,
    check: &impl Fn() -> io::Result<()>,
) -> io::Result<()> {
    directory.root().sync_all()?;
    check()?;
    expected_bytes(directory, leaf, bytes)?;
    check()
}
pub(crate) fn compare_publish(
    directory: &Arc<PrivateDirectory>,
    stages: &Arc<PrivateDirectory>,
    leaf: &Path,
    expected: Option<&[u8]>,
    next: Option<&[u8]>,
    check: impl Fn() -> io::Result<()>,
) -> io::Result<()> {
    if expected.is_some_and(|bytes| bytes.len() > LIMIT)
        || next.is_some_and(|bytes| bytes.len() > LIMIT)
    {
        return Err(refused());
    }
    let target = component(leaf)?;
    check()?;
    directory.private_root()?;
    expected_bytes(directory, leaf, expected)?;
    if let Some(bytes) = next {
        return replace(directory, stages, leaf, &target, expected, bytes, &check);
    }
    if expected.is_some() {
        check()?;
        expected_bytes(directory, leaf, expected)?;
        // SAFETY: owned original directory FD and checked relative leaf; no alias is followed.
        if unsafe { libc::unlinkat(directory.root().as_raw_fd(), target.as_ptr(), 0) } != 0 {
            return Err(io::Error::last_os_error());
        }
    }
    acknowledge(directory, leaf, None, &check)
}
fn replace(
    directory: &Arc<PrivateDirectory>,
    stages: &Arc<PrivateDirectory>,
    leaf: &Path,
    target: &CString,
    expected: Option<&[u8]>,
    bytes: &[u8],
    check: &impl Fn() -> io::Result<()>,
) -> io::Result<()> {
    stage_budget(stages)?;
    check()?;
    let stage_name = name(format!(".opensesame-data-stage-{}", uuid::Uuid::new_v4()).as_bytes())?;
    let file = open_at(
        stages.root(),
        &stage_name,
        libc::O_RDWR | libc::O_CREAT | libc::O_EXCL | libc::O_NOFOLLOW | libc::O_CLOEXEC,
    )?;
    let mut stage = Stage {
        directory: stages,
        component: stage_name,
        file,
        published: false,
    };
    stage.check()?;
    stage.file.write_all(bytes)?;
    stage.file.sync_all()?;
    stage.check()?;
    check()?;
    expected_bytes(directory, leaf, expected)?;
    stage.check()?;
    rename_stage(
        directory,
        stages,
        &stage.component,
        target,
        expected.is_some(),
    )?;
    stage.published = true;
    stage.file.sync_all()?;
    stages.root().sync_all()?;
    stages.private_root()?;
    let actual = stat_at(directory.root(), target)?.ok_or_else(refused)?;
    if !same(&actual, &stage.file.metadata()?) {
        return Err(refused());
    }
    acknowledge(directory, leaf, Some(bytes), check)
}

#[cfg(test)]
#[path = "compare_publish_tests.rs"]
mod tests;
