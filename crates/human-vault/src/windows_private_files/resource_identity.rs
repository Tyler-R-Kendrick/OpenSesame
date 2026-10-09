//! Stable resource identity read from the retained original Windows directory handle.
use super::{handles, security, PrivateDirectory};
use std::io;
impl PrivateDirectory {
    /// Original strict NTFS directory volume serial/file index, not owner authentication.
    /// No path is reopened and no password/root/capability is returned.
    /// # Errors
    /// Refuses changed original ancestry, private ACL/owner/volume or live-handle identity.
    pub fn original_resource_identity(&self) -> io::Result<String> {
        self.validate()?;
        let actual = handles::identity(self.root_handle()?, true)?;
        if self.identities.last() != Some(&actual) {
            return Err(security::refused());
        }
        let binding = actual.resource_binding();
        self.validate()?;
        Ok(binding)
    }
    /// Exact Windows volume serial and full64-bit file index for the Node numeric DATA codec.
    /// This does not claim Unix identity equivalence or change native root-protection AAD.
    /// # Errors
    /// Refuses changed original handles, private profile/ancestry and IO errors.
    pub fn original_node_data_identity(&self) -> io::Result<String> {
        self.validate()?;
        let actual = handles::identity(self.root_handle()?, true)?;
        if self.identities.last() != Some(&actual) {
            return Err(security::refused());
        }
        let binding = actual.node_data_binding();
        self.validate()?;
        Ok(binding)
    }
}

#[cfg(test)]
#[path = "node_data_identity_tests.rs"]
mod tests;
