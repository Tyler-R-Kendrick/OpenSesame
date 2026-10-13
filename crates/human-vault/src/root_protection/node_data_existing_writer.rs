//! Exact physical directory spelling precedes BODY digest selection; DATA custody only.
use super::{
    gate, refused, tomb_name, HeldPrivateWriterLease, NativeNodeCredentialLease,
    NativeNodeDataWriter, PrivateDirectory,
};
use std::{io, path::Path, sync::Arc};
pub(super) fn exact_directory(root: &PrivateDirectory, name: &str, bound: usize) -> io::Result<()> {
    if !root
        .original_bounded_directory_entries(bound)?
        .iter()
        .any(|(actual, directory)| actual == name && *directory)
    {
        return Err(refused());
    }
    root.validate_original()
}
impl NativeNodeCredentialLease {
    /// Acquire selected BODY only for its exact original catalogue spelling under held CRED.
    /// The returned DATA writer retains both actual kernel objects and original ancestry.
    /// # Errors
    /// Refuses invalid/aliased names, bounds, contention, missing/unsafe directories or stale state.
    pub fn capture_existing_writer(
        self: &Arc<Self>,
        tomb: &str,
    ) -> io::Result<NativeNodeDataWriter> {
        self.try_capture_existing_writer(tomb)?.ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::WouldBlock,
                "the original selected BODY is busy",
            )
        })
    }
    /// Try actual selected BODY under this same original held CRED; no lease is reacquired.
    /// # Errors
    /// Refuses unsafe/stale aliases and non-contention IO. Only genuine BODY contention is None.
    pub fn try_capture_existing_writer(
        self: &Arc<Self>,
        tomb: &str,
    ) -> io::Result<Option<NativeNodeDataWriter>> {
        tomb_name(tomb)?;
        let _operation = gate(&self.state.operations)?;
        self.check()?;
        // Windows/APFS aliases must never select one directory under a different BODY digest.
        exact_directory(&self.state.root, "vault", 4096)?;
        exact_directory(&self.state.root, "origin-files", 4096)?;
        let vaults = self.state.root.open_child(Path::new("vault"))?;
        exact_directory(&vaults, tomb, 128)?;
        self.check()?;
        let logical = format!("opensesame:vault-body:{tomb}");
        let body = HeldPrivateWriterLease::try_exclusive(Arc::clone(&self.state.locks), &logical)?;
        self.check()?;
        let Some(body) = body else {
            exact_directory(&self.state.root, "vault", 4096)?;
            exact_directory(&self.state.root, "origin-files", 4096)?;
            exact_directory(&vaults, tomb, 128)?;
            self.check()?;
            return Ok(None);
        };
        let vault = Arc::new(vaults.open_child(Path::new(tomb))?);
        let origin = Arc::new(self.state.root.open_child(Path::new("origin-files"))?);
        exact_directory(&self.state.root, "vault", 4096)?;
        exact_directory(&self.state.root, "origin-files", 4096)?;
        exact_directory(&vaults, tomb, 128)?;
        self.check()?;
        body.validate_exclusive_for(&self.state.locks, &logical)?;
        Ok(Some(NativeNodeDataWriter {
            body,
            credential: Arc::clone(self),
            logical,
            vault,
            origin,
        }))
    }
}
