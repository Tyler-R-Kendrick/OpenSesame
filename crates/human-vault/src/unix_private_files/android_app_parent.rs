//! Provisioning-only policy for the original Android SDK no_backup directory FD.
//! A descriptor selects a physical resource; it never proves existing vault ownership.
use super::*;

fn android_parent_path(root: &Path, uid: u32) -> io::Result<()> {
    let app_id = uid % 100_000;
    if !(10_000..20_000).contains(&app_id) {
        return Err(refused());
    }
    let parent = root.parent().and_then(Path::to_str).ok_or_else(refused)?;
    let parts: Vec<_> = parent.split('/').collect();
    let package = match parts.as_slice() {
        ["", "data", "data", package, "no_backup"] if uid / 100_000 == 0 => *package,
        ["", "data", "user" | "user_de", user, package, "no_backup"]
            if *user == (uid / 100_000).to_string() =>
        {
            *package
        }
        _ => return Err(refused()),
    };
    if !package.contains('.')
        || package.len() > 255
        || package.split('.').any(|part| {
            part.is_empty() || !part.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')
        })
    {
        return Err(refused());
    }
    let leaf = root.file_name().ok_or_else(refused)?.as_bytes();
    if leaf.is_empty()
        || leaf.len() > 128
        || !leaf
            .iter()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_'))
    {
        return Err(refused());
    }
    Ok(())
}

fn original_parent(held: &File, original: &File) -> io::Result<()> {
    let actual = held.metadata()?;
    let anchor = original.metadata()?;
    // SAFETY: the process identity queries take no arguments.
    let uid = unsafe { libc::geteuid() };
    let gid = unsafe { libc::getegid() };
    let supported_mode = actual.mode() & 0o022 == 0
        || (actual.mode() & 0o7777 == 0o771 && actual.gid() == gid && gid == uid);
    if !actual.is_dir()
        || !anchor.is_dir()
        || actual.uid() != uid
        || actual.dev() != anchor.dev()
        || actual.ino() != anchor.ino()
        || actual.uid() != anchor.uid()
        || actual.gid() != anchor.gid()
        || actual.mode() != anchor.mode()
        || !supported_mode
    {
        return Err(refused());
    }
    Ok(())
}

impl PrivateDirectory {
    /// Create a new0700 child beneath the exact original SDK no_backup descriptor.
    /// Permits framework0771 only for the current app UID/GID at that bounded location.
    /// No ancestor aliases are followed, parent permissions changed, or owner proof minted.
    /// # Errors
    /// Refuses other paths, foreign/replaced descriptors, existing children and unsafe modes.
    pub fn create_new_android_app_parent(root: &Path, original: &File) -> io::Result<Self> {
        // SAFETY: geteuid takes no arguments.
        android_parent_path(root, unsafe { libc::geteuid() })?;
        let (mut held, leaf) = Self::pin_entries(root)?;
        original_parent(held.root(), original)?;
        held.validate_entries()?;
        // SAFETY: both the descriptor and bounded leaf remain retained for this syscall.
        if unsafe { libc::mkdirat(held.root().as_raw_fd(), leaf.as_ptr(), 0o700) } < 0 {
            return Err(io::Error::last_os_error());
        }
        original_parent(held.root(), original)?;
        let child = open_at(held.root(), &leaf, directory_flags(true))?;
        let named = stat_at(held.root(), &leaf)?.ok_or_else(refused)?;
        if !same(&named, &child.metadata()?) {
            return Err(refused());
        }
        held.names.push(leaf);
        held.files.push(child);
        // From here onward the existing unchanged strict final-root policy applies.
        held.private_root()?;
        held.root().sync_all()?;
        original_parent(&held.files[held.files.len() - 2], original)?;
        held.private_root()?;
        Ok(held)
    }
}
