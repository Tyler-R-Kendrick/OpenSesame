//! Actual credential→BODY first-vault directory custody; DATA only, never owner authentication.
use super::{
    gate, refused, tomb_name, HeldPrivateWriterLease, NativeNodeCredentialLease,
    NativeNodeDataWriter, PrivateDirectory,
};
#[cfg(test)]
use super::{NativeNodeDataScope, NativeNodeDataState};
use std::{io, path::Path, sync::Arc};
const MAX_TOMBS: usize = 128;
fn exact_child(root: &PrivateDirectory, name: &str, maximum: usize) -> io::Result<bool> {
    let names = root.original_bounded_directory_entries(maximum)?;
    let mut present = false;
    for (actual, directory) in &names {
        #[cfg(any(windows, target_os = "macos", target_os = "ios"))]
        if actual != name && actual.eq_ignore_ascii_case(name) {
            return Err(refused());
        }
        if actual == name && !directory {
            return Err(refused());
        }
        present |= actual == name;
    }
    Ok(present)
}
impl NativeNodeCredentialLease {
    /// Acquire a real BODY lease under this original credential lease and create/open scoped roots.
    /// This permits physical first-vault provisioning, not authenticated owner/realm admission.
    /// Existing unsafe roots are refused without repair. A private empty child can remain on error.
    /// Unix child creation has child+parent fsync; Windows directory power-loss ACK remains separate.
    /// # Errors
    /// Refuses invalid/aliased names, contention, bounds, changed key/state or unsafe original roots.
    pub fn bootstrap_writer(self: &Arc<Self>, tomb: &str) -> io::Result<NativeNodeDataWriter> {
        tomb_name(tomb)?;
        let _operation = gate(&self.state.operations)?;
        self.check()?;
        // Examine existing fixed roots before any provisioning side effect.
        let vault_present = exact_child(&self.state.root, "vault", 4096)?;
        exact_child(&self.state.root, "origin-files", 4096)?;
        let existing = if vault_present {
            Some(self.state.root.open_child(Path::new("vault"))?)
        } else {
            None
        };
        if let Some(vaults) = &existing {
            let present = exact_child(vaults, tomb, MAX_TOMBS)?;
            if !present && vaults.original_bounded_directory_entries(MAX_TOMBS)?.len() == MAX_TOMBS
            {
                return Err(refused());
            }
        }
        let logical = format!("opensesame:vault-body:{tomb}");
        let body = HeldPrivateWriterLease::exclusive(Arc::clone(&self.state.locks), &logical)?;
        self.check()?;
        body.validate_exclusive_for(&self.state.locks, &logical)?;
        let vaults = self.state.root.create_child(Path::new("vault"))?;
        self.check()?;
        // Reobserve actual spelling before opening the selected child on case-insensitive volumes.
        exact_child(&vaults, tomb, MAX_TOMBS)?;
        let vault = Arc::new(vaults.create_child(Path::new(tomb))?);
        self.check()?;
        let origin = Arc::new(self.state.root.create_child(Path::new("origin-files"))?);
        self.check()?;
        if !exact_child(&self.state.root, "vault", 4096)?
            || !exact_child(&self.state.root, "origin-files", 4096)?
            || !exact_child(&vaults, tomb, MAX_TOMBS)?
        {
            return Err(refused());
        }
        let writer = NativeNodeDataWriter {
            body,
            credential: Arc::clone(self),
            logical,
            vault,
            origin,
        };
        writer.check()?;
        Ok(writer)
    }
}
#[cfg(test)]
#[path = "node_data_bootstrap_tests.rs"]
mod tests;
