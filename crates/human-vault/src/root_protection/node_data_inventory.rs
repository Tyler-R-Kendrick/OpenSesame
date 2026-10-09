//! Retained credential-only global filesystem DATA catalogue. It never authenticates a principal.
#[cfg(test)]
use super::NativeNodeDataState;
use super::{
    file_name, gate, refused, tomb_name, HeldPrivateRead, NativeNodeCredentialLease,
    PrivateDirectory,
};
use std::{io, path::Path, sync::Arc};
const MAX_TOMBS: usize = 128;
const MAX_NAMES: usize = 4096;
pub(super) struct Snapshot {
    pub(super) directory: Arc<PrivateDirectory>,
    names: Vec<(String, bool)>,
}
impl Snapshot {
    fn capture(directory: Arc<PrivateDirectory>, maximum: usize) -> io::Result<Self> {
        let names = directory.original_bounded_directory_entries(maximum.max(1))?;
        Ok(Self { directory, names })
    }
    fn validate(&self) -> io::Result<()> {
        self.directory.validate_original()?;
        if self
            .directory
            .original_bounded_directory_entries(self.names.len().max(1))?
            != self.names
        {
            return Err(refused());
        }
        Ok(())
    }
}
fn optional_child(
    root: &Arc<PrivateDirectory>,
    name: &str,
) -> io::Result<Option<Arc<PrivateDirectory>>> {
    let names = root.original_bounded_directory_entries(MAX_NAMES)?;
    match names.iter().find(|(actual, _)| actual == name) {
        None => Ok(None),
        Some((_, true)) => Ok(Some(Arc::new(root.open_child(Path::new(name))?))),
        Some(_) => Err(refused()),
    }
}
fn validate_optional(
    root: &Arc<PrivateDirectory>,
    name: &str,
    snapshot: Option<&Snapshot>,
) -> io::Result<()> {
    if let Some(snapshot) = snapshot {
        return snapshot.validate();
    }
    let names = root.original_bounded_directory_entries(MAX_NAMES)?;
    if names.iter().any(|(actual, _)| actual == name) {
        return Err(refused());
    }
    Ok(())
}
fn identity(directory: &PrivateDirectory) -> io::Result<String> {
    #[cfg(unix)]
    return directory.original_resource_identity();
    #[cfg(windows)]
    directory.original_node_data_identity()
}
/// Actual retained original catalogue/origin/tomb roots, borrowed from a genuine credential lease.
/// Ciphertext/metadata only. No raw state-root/device-key read, factor proof or REAL permit is exposed.
pub struct NativeNodeDeviceInventory {
    pub(super) credential: Arc<NativeNodeCredentialLease>,
    pub(super) origin: Option<Snapshot>,
    catalogue: Option<Snapshot>,
    vaults: Vec<(String, Snapshot)>,
}
impl NativeNodeCredentialLease {
    /// Capture a bounded original device catalogue while this actual credential lease remains held.
    /// Absent directories are explicit retained-root observations, never successor/current fallbacks.
    /// # Errors
    /// Refuses stale/sealed state, unsafe roots, unexpected tomb names/types or resource limits.
    pub fn capture_device_inventory(self: &Arc<Self>) -> io::Result<NativeNodeDeviceInventory> {
        let _operation = gate(&self.state.operations)?;
        self.check()?;
        let origin = optional_child(&self.state.root, "origin-files")?
            .map(|root| Snapshot::capture(root, MAX_NAMES))
            .transpose()?;
        let catalogue = optional_child(&self.state.root, "vault")?
            .map(|root| Snapshot::capture(root, MAX_TOMBS))
            .transpose()?;
        let mut count = origin.as_ref().map_or(0, |snapshot| snapshot.names.len());
        let mut vaults = Vec::new();
        if let Some(catalogue) = &catalogue {
            for (tomb, directory) in &catalogue.names {
                tomb_name(tomb)?;
                if !directory {
                    return Err(refused());
                }
                let root = Arc::new(catalogue.directory.open_child(Path::new(tomb))?);
                let snapshot = Snapshot::capture(root, MAX_NAMES.saturating_sub(count))?;
                count = count
                    .checked_add(snapshot.names.len())
                    .ok_or_else(refused)?;
                if count > MAX_NAMES {
                    return Err(refused());
                }
                vaults.push((tomb.clone(), snapshot));
            }
        }
        let inventory = NativeNodeDeviceInventory {
            credential: Arc::clone(self),
            origin,
            catalogue,
            vaults,
        };
        inventory.check()?;
        Ok(inventory)
    }
}
impl NativeNodeDeviceInventory {
    pub(super) fn check(&self) -> io::Result<()> {
        self.credential.check()?;
        validate_optional(
            &self.credential.state.root,
            "origin-files",
            self.origin.as_ref(),
        )?;
        validate_optional(
            &self.credential.state.root,
            "vault",
            self.catalogue.as_ref(),
        )?;
        for (_, snapshot) in &self.vaults {
            snapshot.validate()?;
        }
        self.credential.check()
    }
    pub(super) fn vault(&self, tomb: &str) -> io::Result<&Snapshot> {
        self.vaults
            .iter()
            .find(|(name, _)| name == tomb)
            .map(|(_, snapshot)| snapshot)
            .ok_or_else(|| {
                io::Error::new(
                    io::ErrorKind::NotFound,
                    "the original catalogue has no selected tomb",
                )
            })
    }
    /// Revalidate the original private lease/key/roots and exact bounded namespace census.
    /// # Errors
    /// Refuses stale/sealed resources, changed inventories and IO failures.
    pub fn validate(&self) -> io::Result<()> {
        let _operation = gate(&self.credential.state.operations)?;
        self.check()
    }
    /// Captured exact actual tomb names; no BODY acquisition or root authentication is implied.
    /// # Errors
    /// Refuses changed original resources and IO failures.
    pub fn tombs(&self) -> io::Result<Vec<String>> {
        let _operation = gate(&self.credential.state.operations)?;
        self.check()?;
        Ok(self.vaults.iter().map(|(name, _)| name.clone()).collect())
    }
    /// Original origin-file names/types; explicitly absent directory yields an empty census.
    /// # Errors
    /// Refuses changed original resources and IO failures.
    pub fn origin_names(&self) -> io::Result<Vec<(String, bool)>> {
        let _operation = gate(&self.credential.state.operations)?;
        self.check()?;
        Ok(self
            .origin
            .as_ref()
            .map_or_else(Vec::new, |snapshot| snapshot.names.clone()))
    }
    /// Original selected vault names/types, restricted to captured exact catalogue spelling.
    /// # Errors
    /// Refuses uncatalogued tombs, stale/sealed resources and IO failures.
    pub fn vault_names(&self, tomb: &str) -> io::Result<Vec<(String, bool)>> {
        let _operation = gate(&self.credential.state.operations)?;
        self.check()?;
        Ok(self.vault(tomb)?.names.clone())
    }
    fn read(&self, snapshot: &Snapshot, leaf: &Path, limit: usize) -> io::Result<Vec<u8>> {
        file_name(leaf)?;
        self.check()?;
        let mut held = HeldPrivateRead::open(Arc::clone(&snapshot.directory), leaf, limit)?;
        held.validate()?;
        self.check()?;
        Ok(held.bytes().to_vec())
    }
    /// Read bounded encrypted physical origin DATA only; the state root and device key are inaccessible.
    /// # Errors
    /// Refuses absent/changed namespaces, unsafe leaves, limits and IO failures.
    pub fn read_origin(&self, leaf: &Path, limit: usize) -> io::Result<Vec<u8>> {
        let _operation = gate(&self.credential.state.operations)?;
        self.check()?;
        let snapshot = self.origin.as_ref().ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::NotFound,
                "the original origin directory is absent",
            )
        })?;
        self.read(snapshot, leaf, limit)
    }
    /// Read bounded encrypted physical DATA from a captured exact tomb only.
    /// # Errors
    /// Refuses absent/changed namespaces, unsafe leaves, limits and IO failures.
    pub fn read_vault(&self, tomb: &str, leaf: &Path, limit: usize) -> io::Result<Vec<u8>> {
        let _operation = gate(&self.credential.state.operations)?;
        self.check()?;
        self.read(self.vault(tomb)?, leaf, limit)
    }
    /// Exact original origin directory OS identity, or explicit absence.
    /// # Errors
    /// Refuses stale/sealed resources and IO failures.
    pub fn origin_identity(&self) -> io::Result<Option<String>> {
        let _operation = gate(&self.credential.state.operations)?;
        self.check()?;
        let result = self
            .origin
            .as_ref()
            .map(|snapshot| identity(&snapshot.directory))
            .transpose()?;
        self.check()?;
        Ok(result)
    }
    /// Exact original selected directory OS identity. Physical DATA, never a real-owner verdict.
    /// # Errors
    /// Refuses uncatalogued tombs, stale/sealed resources and IO failures.
    pub fn vault_identity(&self, tomb: &str) -> io::Result<String> {
        let _operation = gate(&self.credential.state.operations)?;
        self.check()?;
        let result = identity(&self.vault(tomb)?.directory)?;
        self.check()?;
        Ok(result)
    }
}
#[cfg(test)]
#[path = "node_data_inventory_tests.rs"]
mod tests;
