//! Original named BODY-only encrypted DATA reader. No CRED, publication or Owner factory.
use super::{
    ciphertext_reads::{
        binding, identity, modern_name, read_optional, validate, GENERATION, GLOBAL_KEY,
    },
    existing_writer::exact_directory,
    gate, refused, tomb_name, HeldPrivateWriterLease, NativeNodeDataScope, NativeNodeDataState,
    PrivateDirectory,
};
use crate::root_protection::node_at_rest_ciphertext::NodeAtRestDomain;
use std::{io, path::Path, sync::Arc};
/// A distinct readonly physical object borrowing only an actual original named BODY lease.
/// It exposes authenticated ciphertext DATA and cannot issue an ordered writer or real principal.
pub struct NativeNodeDataReader {
    state: Arc<NativeNodeDataState>,
    body: HeldPrivateWriterLease,
    logical: String,
    tomb: String,
    vault: Arc<PrivateDirectory>,
    origin: Arc<PrivateDirectory>,
}
impl NativeNodeDataState {
    /// Consume a genuine same-state shared/exclusive selected BODY lease into readonly DATA custody.
    /// # Errors
    /// Refuses wrong name/mode/original root, unsafe or aliased resources and stale state.
    pub fn capture_body_reader(
        self: &Arc<Self>,
        tomb: &str,
        body: HeldPrivateWriterLease,
    ) -> io::Result<NativeNodeDataReader> {
        tomb_name(tomb)?;
        let _operation = gate(&self.operations)?;
        self.check()?;
        let logical = format!("opensesame:vault-body:{tomb}");
        body.validate_read_for(&self.locks, &logical)?;
        exact_directory(&self.root, "vault", 4096)?;
        exact_directory(&self.root, "origin-files", 4096)?;
        let vaults = self.root.open_child(Path::new("vault"))?;
        exact_directory(&vaults, tomb, 128)?;
        let vault = Arc::new(vaults.open_child(Path::new(tomb))?);
        let origin = Arc::new(self.root.open_child(Path::new("origin-files"))?);
        exact_directory(&self.root, "vault", 4096)?;
        exact_directory(&self.root, "origin-files", 4096)?;
        exact_directory(&vaults, tomb, 128)?;
        let reader = NativeNodeDataReader {
            state: Arc::clone(self),
            body,
            logical,
            tomb: tomb.to_owned(),
            vault,
            origin,
        };
        reader.check()?;
        Ok(reader)
    }
}
impl NativeNodeDataReader {
    fn check(&self) -> io::Result<()> {
        self.state.check()?;
        self.body
            .validate_read_for(&self.state.locks, &self.logical)?;
        self.vault.validate_original()?;
        self.origin.validate_original()
    }
    /// Revalidate original readonly custody under the retained native operation gate.
    /// # Errors
    /// Refuses sealed/stale state or changed original physical resources.
    pub fn validate(&self) -> io::Result<()> {
        let _operation = gate(&self.state.operations)?;
        self.check()
    }
    /// Return authenticated osr2 from the exact generation leaf, or genuine corroborated absence.
    /// # Errors
    /// Refuses changed or unsafe present files, plaintext, invalid ciphertext and IO errors.
    pub fn read_optional_generation_ciphertext(&self) -> io::Result<Option<Vec<u8>>> {
        let _operation = gate(&self.state.operations)?;
        self.check()?;
        let context = binding(&self.tomb, &identity(&self.vault)?)?;
        let Some(mut held) = read_optional(&self.vault, GENERATION)? else {
            self.check()?;
            return Ok(None);
        };
        held.validate()?;
        if !held.bytes().starts_with(b"osr2.") {
            return Err(refused());
        }
        validate(
            &self.state,
            NodeAtRestDomain::VaultGeneration,
            &context,
            held.bytes(),
        )?;
        held.validate()?;
        self.check()?;
        Ok(Some(held.bytes().to_vec()))
    }
    /// Return authenticated exact selected-tomb modern device DATA; only fixed global enrollment is allowed.
    /// # Errors
    /// Refuses foreign logical context, unsafe files, plaintext/invalid ciphertext or IO failures.
    pub fn read_optional_modern_device_ciphertext(
        &self,
        logical: &str,
    ) -> io::Result<Option<Vec<u8>>> {
        let _operation = gate(&self.state.operations)?;
        self.check()?;
        if logical != GLOBAL_KEY && !logical.starts_with(&format!("tomb/{}/", self.tomb)) {
            return Err(refused());
        }
        let leaf = modern_name(logical)?;
        let context = binding(logical, &leaf)?;
        let Some(mut held) = read_optional(&self.origin, &leaf)? else {
            self.check()?;
            return Ok(None);
        };
        held.validate()?;
        validate(
            &self.state,
            NodeAtRestDomain::DeviceRecord,
            &context,
            held.bytes(),
        )?;
        held.validate()?;
        self.check()?;
        Ok(Some(held.bytes().to_vec()))
    }
    fn directory(&self, scope: NativeNodeDataScope) -> &PrivateDirectory {
        match scope {
            NativeNodeDataScope::Vault => &self.vault,
            NativeNodeDataScope::Origin => &self.origin,
        }
    }
    /// Enumerate bounded names/types from this original selected DATA scope only.
    /// # Errors
    /// Refuses sealed/stale state or unsafe/changed physical resources and entry limits.
    pub fn inventory(
        &self,
        scope: NativeNodeDataScope,
        maximum: usize,
    ) -> io::Result<Vec<(String, bool)>> {
        let _operation = gate(&self.state.operations)?;
        self.check()?;
        let names = self
            .directory(scope)
            .original_bounded_directory_entries(maximum)?;
        self.check()?;
        Ok(names)
    }
    /// Original physical directory identity DATA, never an Owner or lease grant.
    /// # Errors
    /// Refuses sealed/stale state or changed original custody.
    pub fn resource_identity(&self, scope: NativeNodeDataScope) -> io::Result<String> {
        let _operation = gate(&self.state.operations)?;
        self.check()?;
        let original = identity(self.directory(scope))?;
        self.check()?;
        Ok(original)
    }
}
