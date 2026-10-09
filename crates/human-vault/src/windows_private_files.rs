//! Owner-private physical directory pins, not password or vault-root authority.
//! Existing roots are checked, never chmodded, repaired or silently provisioned.

#[path = "windows_private_files/handles.rs"]
mod handles;
#[path = "windows_private_files/security.rs"]
mod security;

#[path = "windows_private_files/publish.rs"]
mod publish;
pub use publish::{atomic_write, atomic_write_with, write_new};

use std::{
    fs::File,
    io,
    path::{Path, PathBuf},
};

/// A local NTFS root and every ancestor retained without delete sharing.
/// This object proves a bounded filesystem profile, never authentication.
pub struct PrivateDirectory {
    parents: Vec<File>,
    paths: Vec<PathBuf>,
    identities: Vec<handles::Identity>,
    owner: String,
}

impl PrivateDirectory {
    /// Open an existing absolute, non-aliased root with the strict private profile.
    ///
    /// # Errors
    /// Refuses reparse paths, unsupported volumes, broad/foreign ACLs and IO errors.
    pub fn open(root: &Path) -> io::Result<Self> {
        let owner = security::owner_sid()?;
        let paths = handles::prefixes(root)?;
        let mut parents = Vec::new();
        let mut identities = Vec::new();
        for path in &paths {
            let file = handles::directory(path)?;
            identities.push(handles::identity(&file, true)?);
            if let Some(parent) = parents.last() {
                let name = path
                    .file_name()
                    .and_then(|value| value.to_str())
                    .ok_or_else(security::refused)?;
                handles::child_relation(parent, &file, name)?;
            }
            parents.push(file);
        }
        let opened = Self {
            parents,
            paths,
            identities,
            owner,
        };
        opened.validate()?;
        Ok(opened)
    }

    pub(crate) fn validate(&self) -> io::Result<()> {
        if security::owner_sid()? != self.owner {
            return Err(security::refused());
        }
        for (index, parent) in self.parents.iter().enumerate() {
            if handles::identity(parent, true)? != self.identities[index] {
                return Err(security::refused());
            }
            if index > 0 {
                let name = self.paths[index]
                    .file_name()
                    .and_then(|value| value.to_str())
                    .ok_or_else(security::refused)?;
                handles::child_relation(&self.parents[index - 1], parent, name)?;
            }
        }
        handles::drive_relation(&self.parents[0], &self.paths[0])?;
        let root = self.parents.last().ok_or_else(security::refused)?;
        handles::local_ntfs(root, &self.paths[0])?;
        security::verify(root, &self.owner, true)
    }

    pub(crate) fn path_for(&self, name: &Path) -> io::Result<PathBuf> {
        let text = name.to_str().ok_or_else(security::refused)?;
        handles::component_policy(text)?;
        let root = self.paths.last().ok_or_else(security::refused)?;
        let path = root.join(name);
        if path
            .to_str()
            .ok_or_else(security::refused)?
            .encode_utf16()
            .count()
            > 32760
        {
            return Err(security::refused());
        }
        Ok(path)
    }

    pub(crate) fn root_handle(&self) -> io::Result<&File> {
        self.parents.last().ok_or_else(security::refused)
    }
}
