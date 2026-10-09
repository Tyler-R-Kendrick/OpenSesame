//! Exact inherited root pins and owner-private nested directories, not owner authority.
use super::{create_private_directory_new, handles, security, PrivateDirectory};
use std::{fs::File, io, path::Path};

impl PrivateDirectory {
    /// Open one existing owner-private normal child, retaining the original chain.
    /// No path locator is reopened as an independent authority root.
    /// # Errors
    /// Refuses changed roots, broad/foreign ACLs, aliases, reparse nodes and IO failures.
    pub fn open_child(&self, name: &Path) -> io::Result<Self> {
        self.child(name, false)
    }

    /// Open an existing private child or create an absent child with a private ACL.
    /// Existing ACLs are verified, never repaired. A raced creation is refused.
    /// A private empty child may remain after a later validation failure.
    /// This physical primitive does not authenticate a vault owner.
    /// # Errors
    /// Refuses unsafe physical profiles, changed original chains, aliases and IO failures.
    pub fn create_child(&self, name: &Path) -> io::Result<Self> {
        self.child(name, true)
    }

    /// Revalidate this retained original physical chain, without creating any authority.
    /// # Errors
    /// Refuses changed identities, owner/ACLs, parent relationships or unsupported volumes.
    pub fn validate_original(&self) -> io::Result<()> {
        self.validate()
    }

    fn child(&self, name: &Path, create_missing: bool) -> io::Result<Self> {
        self.validate()?;
        if self.parents.len() >= 128 {
            return Err(security::refused());
        }
        let path = self.path_for(name)?;
        let text = name.to_str().ok_or_else(security::refused)?;
        let opened = match handles::directory(&path) {
            Ok(file) => file,
            Err(error) if create_missing && error.kind() == io::ErrorKind::NotFound => {
                self.validate()?;
                create_private_directory_new(&path, &self.owner)?;
                self.validate()?;
                handles::directory(&path)?
            }
            Err(error) => return Err(error),
        };
        security::verify(&opened, &self.owner, true)?;
        let identity = handles::identity(&opened, true)?;
        handles::child_relation(self.root_handle()?, &opened, text)?;
        let mut parents = self
            .parents
            .iter()
            .map(File::try_clone)
            .collect::<io::Result<Vec<_>>>()?;
        let mut paths = self.paths.clone();
        let mut identities = self.identities.clone();
        parents.push(opened);
        paths.push(path);
        identities.push(identity);
        let child = Self {
            parents,
            paths,
            identities,
            owner: self.owner.clone(),
            private_start: self.private_start,
        };
        self.validate()?;
        child.validate()?;
        Ok(child)
    }
}

#[cfg(test)]
#[path = "child_tests.rs"]
mod child_tests;
