//! Generic retained child roots and resource metadata, never owner authentication.
use super::{directory_flags, name, open_at, refused, same, stat_at, PrivateDirectory};
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
fn child_name(leaf: &Path) -> io::Result<CString> {
    let mut parts = leaf.components();
    let Some(Component::Normal(part)) = parts.next() else {
        return Err(refused());
    };
    if parts.next().is_some()
        || part.as_bytes().len() > 255
        || leaf.as_os_str().as_bytes() != part.as_bytes()
    {
        return Err(refused());
    }
    name(part.as_bytes())
}
impl PrivateDirectory {
    /// Open an existing strict private child relative to this exact retained original root.
    /// # Errors
    /// Refuses aliases, unsafe owner/mode, stale ancestry, path budgets and IO failures.
    pub fn open_child(&self, leaf: &Path) -> io::Result<Self> {
        self.child(leaf, false)
    }
    /// Create a missing private child or validate an existing one, without repair.
    /// Child creation and original-parent metadata receive genuine directory sync ACK.
    /// # Errors
    /// Refuses unsafe/raced nonprivate objects or IO; private empty child can remain on later failure.
    pub fn create_child(&self, leaf: &Path) -> io::Result<Self> {
        self.child(leaf, true)
    }
    /// Create only a new private child relative to this exact retained original parent.
    /// # Errors
    /// Refuses existing children, invalid names/depth, changed roots and sync failures.
    /// A newly created private directory may remain after a later IO failure.
    pub fn create_new_child(&self, leaf: &Path) -> io::Result<Self> {
        self.private_root()?;
        let component = child_name(leaf)?;
        if self.files.len() >= 128
            || self
                .names
                .iter()
                .map(|n| n.to_bytes().len() + 1)
                .sum::<usize>()
                + component.to_bytes().len()
                > 4096
        {
            return Err(refused());
        }
        // SAFETY: actual retained parent FD and checked one-component name remain owned.
        if unsafe { libc::mkdirat(self.root().as_raw_fd(), component.as_ptr(), 0o700) } != 0 {
            return Err(io::Error::last_os_error());
        }
        self.private_root()?;
        let child = self.child(leaf, false)?;
        child.root().sync_all()?;
        self.root().sync_all()?;
        self.private_root()?;
        child.private_root()?;
        Ok(child)
    }
    /// Validate actual original private ancestry. Physical DATA only, not credential proof.
    /// # Errors
    /// Refuses substituted ancestry, changed owner/mode and IO failures.
    pub fn validate_original(&self) -> io::Result<()> {
        self.private_root()
    }
    /// Exact retained device/inode textual resource identity used by existing Node AEAD binding.
    /// # Errors
    /// Refuses changed original ancestry or physical profile; never yields owner authority.
    pub fn original_resource_identity(&self) -> io::Result<String> {
        self.private_root()?;
        let original = self.root().metadata()?;
        let identity = format!("{}:{}", original.dev(), original.ino());
        self.private_root()?;
        Ok(identity)
    }
    /// Corroborate one actual absent entry using this retained original directory FD.
    /// Physical DATA only: absence never authenticates a password, Owner or writer lease.
    /// # Errors
    /// Refuses invalid leaves, changed ancestry and every lookup error other than ENOENT.
    pub fn original_entry_absent(&self, leaf: &Path) -> io::Result<bool> {
        self.private_root()?;
        let name = child_name(leaf)?;
        let absent = stat_at(self.root(), &name)?.is_none();
        self.private_root()?;
        Ok(absent)
    }
    fn child(&self, leaf: &Path, create: bool) -> io::Result<Self> {
        self.private_root()?;
        let component = child_name(leaf)?;
        if self.files.len() >= 128
            || self
                .names
                .iter()
                .map(|n| n.to_bytes().len() + 1)
                .sum::<usize>()
                + component.to_bytes().len()
                > 4096
        {
            return Err(refused());
        }
        let absent = stat_at(self.root(), &component)?.is_none();
        if absent && create {
            create_private_child(self.root(), &component)?;
        }
        let child = open_at(self.root(), &component, directory_flags(true))?;
        let observed = stat_at(self.root(), &component)?.ok_or_else(refused)?;
        if !same(&observed, &child.metadata()?) {
            return Err(refused());
        }
        let mut result = Self {
            files: self
                .files
                .iter()
                .map(File::try_clone)
                .collect::<io::Result<Vec<_>>>()?,
            names: self.names.clone(),
            private_start: self.private_start,
            #[cfg(any(target_os = "macos", target_os = "ios"))]
            aliases: self.aliases.clone(),
        };
        result.files.push(child);
        result.names.push(component);
        result.private_root()?;
        if create && absent {
            result.root().sync_all()?;
            self.root().sync_all()?;
        }
        self.private_root()?;
        result.private_root()?;
        Ok(result)
    }
}

fn create_private_child(parent: &File, component: &CString) -> io::Result<()> {
    // SAFETY: original retained parent FD and bounded one-component name stay owned.
    if unsafe { libc::mkdirat(parent.as_raw_fd(), component.as_ptr(), 0o700) } != 0 {
        let error = io::Error::last_os_error();
        if error.kind() != io::ErrorKind::AlreadyExists {
            return Err(error);
        }
    }
    Ok(())
}
