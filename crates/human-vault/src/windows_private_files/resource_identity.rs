//! Stable resource identity read from the retained original Windows directory handle.
use super::*;
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
}
