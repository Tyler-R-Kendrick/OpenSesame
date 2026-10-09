//! Original retained Node DATA and genuine ordered physical leases, never owner authentication.
#[cfg(unix)]
use super::unix_private_files::{HeldPrivateRead, HeldPrivateWriterLease, PrivateDirectory};
#[cfg(windows)]
use super::windows_private_files::{HeldPrivateRead, HeldPrivateWriterLease, PrivateDirectory};
use base64::{engine::general_purpose::STANDARD, Engine};
use std::{
    io,
    path::Path,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, MutexGuard,
    },
};
use zeroize::Zeroizing;
pub const NODE_CREDENTIAL_LEASE: &str = "opensesame.retired-credentials";
const NODE_LOCK_DIRECTORY: &str = "vault-locks-native-v1";
fn refused() -> io::Error {
    io::Error::new(
        io::ErrorKind::PermissionDenied,
        "the original Node DATA resource is unavailable",
    )
}
fn gate(lock: &Mutex<()>) -> io::Result<MutexGuard<'_, ()>> {
    lock.lock().map_err(|_| refused())
}
fn tomb_name(tomb: &str) -> io::Result<()> {
    if tomb.is_empty()
        || tomb.len() > 200
        || !tomb.as_bytes()[0].is_ascii_alphanumeric()
        || !tomb
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
    {
        return Err(refused());
    }
    Ok(())
}
fn file_name(leaf: &Path) -> io::Result<()> {
    let text = leaf.to_str().ok_or_else(refused)?;
    if text.is_empty()
        || text.len() > 255
        || text == "."
        || text == ".."
        || text.contains(['/', '\\', '\0'])
    {
        return Err(refused());
    }
    Ok(())
}
/// Private original state, key-file pin and OS protocol root. No key or REAL permit is exposed.
pub struct NativeNodeDataState {
    root: Arc<PrivateDirectory>,
    locks: Arc<PrivateDirectory>,
    key_file: Mutex<HeldPrivateRead>,
    device_key: Zeroizing<[u8; 32]>,
    operations: Mutex<()>,
    sealed: AtomicBool,
}
impl NativeNodeDataState {
    /// Capture an existing strict private Node state and exact durable device-key file.
    /// The dedicated native lock child is created/validated outside all protected DATA inventories.
    /// # Errors
    /// Refuses unsafe storage, absent/wrong-sized key files or changed original resources.
    pub fn capture(root: Arc<PrivateDirectory>) -> io::Result<Arc<Self>> {
        root.validate_original()?;
        let mut key_file = HeldPrivateRead::open(Arc::clone(&root), Path::new("at-rest.key"), 128)?;
        key_file.validate()?;
        let device_key = decode_device_key_wire(key_file.bytes())?;
        key_file.validate()?;
        let locks = Arc::new(root.create_child(Path::new(NODE_LOCK_DIRECTORY))?);
        let state = Arc::new(Self {
            root,
            locks,
            key_file: Mutex::new(key_file),
            device_key,
            operations: Mutex::new(()),
            sealed: AtomicBool::new(false),
        });
        state.check()?;
        Ok(state)
    }
    fn check(&self) -> io::Result<()> {
        if self.sealed.load(Ordering::Acquire) {
            return Err(refused());
        }
        self.root.validate_original()?;
        self.locks.validate_original()?;
        let mut original = self.key_file.lock().map_err(|_| refused())?;
        original.validate()?;
        let decoded = decode_device_key_wire(original.bytes())?;
        if blake3::Hash::from_bytes(*decoded) != blake3::Hash::from_bytes(*self.device_key) {
            return Err(refused());
        }
        original.validate()
    }
    /// Revalidate this original retained DATA resource under its synchronous operation gate.
    /// # Errors
    /// Refuses sealed/stale state, changed keys/directories/leases and IO failures.
    pub fn validate(&self) -> io::Result<()> {
        let _operation = gate(&self.operations)?;
        self.check()
    }
    /// Acquire a genuine shared generic Host lease. It cannot become a credential writer.
    /// # Errors
    /// Refuses closed/stale state, invalid names, contention or unsafe kernel resources.
    pub fn shared_lease(&self, logical: &str) -> io::Result<HeldPrivateWriterLease> {
        let _operation = gate(&self.operations)?;
        self.check()?;
        let held = HeldPrivateWriterLease::shared(Arc::clone(&self.locks), logical)?;
        self.check()?;
        Ok(held)
    }
    /// Acquire a genuine exclusive generic Host lease, without ordered publication custody.
    /// # Errors
    /// Refuses closed/stale state, invalid names, contention or unsafe kernel resources.
    pub fn exclusive_lease(&self, logical: &str) -> io::Result<HeldPrivateWriterLease> {
        let _operation = gate(&self.operations)?;
        self.check()?;
        let held = HeldPrivateWriterLease::exclusive(Arc::clone(&self.locks), logical)?;
        self.check()?;
        Ok(held)
    }
    /// Acquire the actual original credential-exclusive lease before any selected BODY acquisition.
    /// # Errors
    /// Refuses closed/stale state, contention or an invalid private kernel resource.
    pub fn credential_writer(self: &Arc<Self>) -> io::Result<Arc<NativeNodeCredentialLease>> {
        let _operation = gate(&self.operations)?;
        self.check()?;
        let credential =
            HeldPrivateWriterLease::exclusive(Arc::clone(&self.locks), NODE_CREDENTIAL_LEASE)?;
        self.check()?;
        Ok(Arc::new(NativeNodeCredentialLease {
            state: Arc::clone(self),
            credential,
        }))
    }
    /// Drain synchronous native DATA operations and permanently refuse subsequent operations.
    /// Actual caller objects retain their kernel handles until their own final drop.
    /// # Errors
    /// Refuses a poisoned operation gate; no successor state is admitted.
    pub fn seal(&self) -> io::Result<()> {
        let _operation = gate(&self.operations)?;
        self.sealed.store(true, Ordering::Release);
        Ok(())
    }
}
/// Actual retained credential OS lease. Construction is private to the original state producer.
pub struct NativeNodeCredentialLease {
    state: Arc<NativeNodeDataState>,
    credential: HeldPrivateWriterLease,
}
impl NativeNodeCredentialLease {
    fn check(&self) -> io::Result<()> {
        self.state.check()?;
        self.credential
            .validate_exclusive_for(&self.state.locks, NODE_CREDENTIAL_LEASE)
    }
    /// Revalidate this original retained DATA resource under its synchronous operation gate.
    /// # Errors
    /// Refuses sealed/stale state, changed keys/directories/leases and IO failures.
    pub fn validate(&self) -> io::Result<()> {
        let _operation = gate(&self.state.operations)?;
        self.check()
    }
    /// Acquire an actual selected BODY exclusive lease while this credential lease remains held.
    /// The returned DATA writer retains both exact kernel objects and original directory ancestry.
    /// # Errors
    /// Refuses invalid tombs, contention, missing directories, stale keys/state or unsafe storage.
    pub fn capture_existing_writer(
        self: &Arc<Self>,
        tomb: &str,
    ) -> io::Result<NativeNodeDataWriter> {
        tomb_name(tomb)?;
        let _operation = gate(&self.state.operations)?;
        self.check()?;
        let logical = format!("opensesame:vault-body:{tomb}");
        let body = HeldPrivateWriterLease::exclusive(Arc::clone(&self.state.locks), &logical)?;
        let vaults = self.state.root.open_child(Path::new("vault"))?;
        let vault = Arc::new(vaults.open_child(Path::new(tomb))?);
        let origin = Arc::new(self.state.root.open_child(Path::new("origin-files"))?);
        self.check()?;
        body.validate_exclusive_for(&self.state.locks, &logical)?;
        Ok(NativeNodeDataWriter {
            body,
            credential: Arc::clone(self),
            logical,
            vault,
            origin,
        })
    }
}
/// Selection of the two already retained Node DATA directories.
#[derive(Clone, Copy)]
pub enum NativeNodeDataScope {
    Vault,
    Origin,
}
/// Opaque ordered physical DATA writer. The name implies IO custody, never a real-vault realm.
/// No mutation entrypoint is provided until genuine expected-byte durable publication is closed.
pub struct NativeNodeDataWriter {
    // Drop BODY before the retained credential object, preserving physical release order.
    body: HeldPrivateWriterLease,
    credential: Arc<NativeNodeCredentialLease>,
    logical: String,
    vault: Arc<PrivateDirectory>,
    origin: Arc<PrivateDirectory>,
}
impl NativeNodeDataWriter {
    fn directory(&self, scope: NativeNodeDataScope) -> &Arc<PrivateDirectory> {
        match scope {
            NativeNodeDataScope::Vault => &self.vault,
            NativeNodeDataScope::Origin => &self.origin,
        }
    }
    fn check(&self) -> io::Result<()> {
        self.credential.check()?;
        self.body
            .validate_exclusive_for(&self.credential.state.locks, &self.logical)?;
        self.vault.validate_original()?;
        self.origin.validate_original()
    }
    /// Revalidate this original retained DATA resource under its synchronous operation gate.
    /// # Errors
    /// Refuses sealed/stale state, changed keys/directories/leases and IO failures.
    pub fn validate(&self) -> io::Result<()> {
        let _operation = gate(&self.credential.state.operations)?;
        self.check()
    }
    /// Compare exact bytes and publish/delete through retained Unix roots under actual ordered leases.
    /// A bounded dedicated stage directory lies outside protected origin/vault inventories.
    /// # Errors
    /// Refuses stale/closed state, byte mismatches, unsafe profiles and IO failures.
    /// An error after a successful namespace effect does not imply rollback.
    #[cfg(unix)]
    pub fn compare_publish(
        &self,
        scope: NativeNodeDataScope,
        leaf: &Path,
        expected: Option<&[u8]>,
        next: Option<&[u8]>,
    ) -> io::Result<()> {
        file_name(leaf)?;
        let _operation = gate(&self.credential.state.operations)?;
        self.check()?;
        let stages = Arc::new(
            self.credential
                .state
                .root
                .create_child(Path::new("vault-native-stages-v1"))?,
        );
        super::unix_private_files::compare_publish(
            self.directory(scope),
            &stages,
            leaf,
            expected,
            next,
            || self.check(),
        )
    }
    /// Return one bounded original private file's physical bytes. DATA, not AEAD/owner proof.
    /// # Errors
    /// Refuses unsafe names, absent files, exceeded limits, stale/closed state and IO errors.
    pub fn read(
        &self,
        scope: NativeNodeDataScope,
        leaf: &Path,
        limit: usize,
    ) -> io::Result<Vec<u8>> {
        file_name(leaf)?;
        let _operation = gate(&self.credential.state.operations)?;
        self.check()?;
        let mut held = HeldPrivateRead::open(Arc::clone(self.directory(scope)), leaf, limit)?;
        held.validate()?;
        self.check()?;
        Ok(held.bytes().to_vec())
    }
    /// Return bounded actual names/types beneath the exact captured physical DATA directory.
    /// # Errors
    /// Refuses changed/closed resources, unsupported nodes, limits and IO errors.
    pub fn inventory(
        &self,
        scope: NativeNodeDataScope,
        maximum: usize,
    ) -> io::Result<Vec<(String, bool)>> {
        let _operation = gate(&self.credential.state.operations)?;
        self.check()?;
        let names = self
            .directory(scope)
            .original_bounded_directory_entries(maximum)?;
        self.check()?;
        Ok(names)
    }
    /// Original physical resource identity for existing Node AEAD context; grants no authority.
    /// # Errors
    /// Refuses stale/closed original resources or IO errors.
    pub fn resource_identity(&self, scope: NativeNodeDataScope) -> io::Result<String> {
        let _operation = gate(&self.credential.state.operations)?;
        self.check()?;
        #[cfg(unix)]
        let identity = self.directory(scope).original_resource_identity()?;
        #[cfg(windows)]
        let identity = self.directory(scope).original_node_data_identity()?;
        self.check()?;
        Ok(identity)
    }
}
#[cfg(test)]
#[path = "node_data_state_tests.rs"]
mod tests;

// Original Node writer stores canonical STANDARD base64 plus one optional final LF.
// The raw encoded bytes remain pinned by HeldPrivateRead; decoded secret never leaves this state.
fn decode_device_key_wire(wire: &[u8]) -> io::Result<Zeroizing<[u8; 32]>> {
    let text = std::str::from_utf8(wire).map_err(|_| refused())?;
    let text = text.strip_suffix('\n').unwrap_or(text);
    if text.len() != 44 {
        return Err(refused());
    }
    let decoded = Zeroizing::new(STANDARD.decode(text).map_err(|_| refused())?);
    let canonical = Zeroizing::new(STANDARD.encode(&*decoded));
    if decoded.len() != 32 || canonical.as_str() != text {
        return Err(refused());
    }
    Ok(Zeroizing::new(
        decoded.as_slice().try_into().map_err(|_| refused())?,
    ))
}
#[cfg(test)]
#[path = "node_data_key_wire_tests.rs"]
mod key_wire_tests;

#[path = "node_data_inventory.rs"]
mod device_inventory;
pub use device_inventory::NativeNodeDeviceInventory;
