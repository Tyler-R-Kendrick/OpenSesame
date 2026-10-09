//! Fixed physical Node encrypted DATA lanes. No key/plaintext egress or owner grant.
#[cfg(test)]
use super::NativeNodeDataScope;
use super::{
    file_name, gate, refused, tomb_name, HeldPrivateRead, NativeNodeDataState,
    NativeNodeDataWriter, NativeNodeDeviceInventory, PrivateDirectory,
};
use crate::root_protection::node_at_rest_ciphertext::{
    validate_node_at_rest_ciphertext, NodeAtRestDomain,
};
use sha2::{Digest, Sha256};
use std::{io, path::Path, sync::Arc};
const LIMIT: usize = 16 * 1024 * 1024;
const GLOBAL_KEY: &str = "duress.enrollment-state.v1";
const GENERATION: &str = "opensesame-generation.v1.json";
fn digest(text: &str) -> String {
    format!("{:x}", Sha256::digest(text.as_bytes()))
}
fn modern_name(logical: &str) -> io::Result<String> {
    if logical.is_empty()
        || logical.len() > 512
        || !logical.as_bytes()[0].is_ascii_alphanumeric()
        || !logical
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._/-".contains(&b))
    {
        return Err(refused());
    }
    let parts = logical.split('/').collect::<Vec<_>>();
    if parts
        .iter()
        .any(|part| part.is_empty() || *part == "." || *part == "..")
    {
        return Err(refused());
    }
    let scope = if parts[0] == "tomb" {
        if parts.len() < 3 {
            return Err(refused());
        }
        tomb_name(parts[1])?;
        format!("tomb/{}", parts[1])
    } else {
        "global".into()
    };
    Ok(format!(
        "opensesame-pages-node-record-v2-{}-{}.json",
        digest(&scope),
        digest(logical)
    ))
}
fn binding(left: &str, right: &str) -> io::Result<String> {
    serde_json::to_string(&[left, right]).map_err(|_| refused())
}
fn validate(
    state: &NativeNodeDataState,
    domain: NodeAtRestDomain,
    name: &str,
    bytes: &[u8],
) -> io::Result<()> {
    state.check()?;
    {
        let mut key_file = state.key_file.lock().map_err(|_| refused())?;
        key_file.validate()?;
        validate_node_at_rest_ciphertext(&*state.device_key, domain, name, bytes)?;
        key_file.validate()?;
    }
    // Release the original key mutex before check re-borrows it; never deadlock or retarget.
    state.check()
}
fn read_optional(
    directory: &Arc<PrivateDirectory>,
    leaf: &str,
) -> io::Result<Option<HeldPrivateRead>> {
    file_name(Path::new(leaf))?;
    directory.validate_original()?;
    let names = directory.original_bounded_directory_entries(4096)?;
    if let Some((_, is_directory)) = names.iter().find(|(name, _)| name == leaf) {
        if *is_directory {
            return Err(refused());
        }
        return HeldPrivateRead::open(Arc::clone(directory), Path::new(leaf), LIMIT).map(Some);
    }
    // Exact spelling census alone cannot prove absence on a casefolding filesystem.
    // Corroborate actual kernel lookup; present aliases and all other errors refuse.
    if !directory.original_entry_absent(Path::new(leaf))? {
        return Err(refused());
    }
    directory.validate_original()?;
    if directory.original_bounded_directory_entries(4096)? != names {
        return Err(refused());
    }
    if !directory.original_entry_absent(Path::new(leaf))? {
        return Err(refused());
    }
    directory.validate_original()?;
    Ok(None)
}
fn missing() -> io::Error {
    io::Error::new(
        io::ErrorKind::NotFound,
        "exact original Node ciphertext leaf is absent",
    )
}
fn identity(directory: &PrivateDirectory) -> io::Result<String> {
    #[cfg(unix)]
    return directory.original_resource_identity();
    #[cfg(windows)]
    directory.original_node_data_identity()
}
impl NativeNodeDataWriter {
    /// Authenticate only the fixed generation leaf with actual retained tomb/directory identity.
    /// The independently authenticated inner Node generation codec remains the Node consumer's job.
    /// # Errors
    /// Refuses missing/changed physical resources, plaintext/invalid outer AEAD or IO failures.
    pub fn read_generation_ciphertext(&self) -> io::Result<Vec<u8>> {
        self.read_optional_generation_ciphertext()?
            .ok_or_else(missing)
    }
    /// Observe exact original generation absence or authenticate its osr2 ciphertext.
    /// # Errors
    /// Refuses present-file failures and changed roots; IO errors never become absence.
    pub fn read_optional_generation_ciphertext(&self) -> io::Result<Option<Vec<u8>>> {
        let _operation = gate(&self.credential.state.operations)?;
        self.check()?;
        let tomb = self
            .logical
            .strip_prefix("opensesame:vault-body:")
            .ok_or_else(refused)?;
        tomb_name(tomb)?;
        let context = binding(tomb, &identity(&self.vault)?)?;
        let Some(mut held) = read_optional(&self.vault, GENERATION)? else {
            self.check()?;
            return Ok(None);
        };
        held.validate()?;
        if !held.bytes().starts_with(b"osr2.") {
            return Err(refused());
        }
        validate(
            &self.credential.state,
            NodeAtRestDomain::VaultGeneration,
            &context,
            held.bytes(),
        )?;
        held.validate()?;
        self.check()?;
        Ok(Some(held.bytes().to_vec()))
    }
    /// Authenticate an exact modern device record in this writer's original selected tomb.
    /// Only the fixed device-global enrollment-state key is readable outside that tomb scope.
    /// No legacy slash alias/name fallback or request-supplied physical name/domain is accepted.
    /// # Errors
    /// Refuses foreign logical scope, plaintext/invalid AEAD, unsafe original files or IO failures.
    pub fn read_modern_device_ciphertext(&self, logical_key: &str) -> io::Result<Vec<u8>> {
        self.read_optional_modern_device_ciphertext(logical_key)?
            .ok_or_else(missing)
    }
    /// Observe exact original modern-device absence or authenticate its actual ciphertext.
    /// # Errors
    /// Refuses foreign scope/present-file/ancestor failures instead of masking them as absence.
    pub fn read_optional_modern_device_ciphertext(
        &self,
        logical_key: &str,
    ) -> io::Result<Option<Vec<u8>>> {
        let _operation = gate(&self.credential.state.operations)?;
        self.check()?;
        let tomb = self
            .logical
            .strip_prefix("opensesame:vault-body:")
            .ok_or_else(refused)?;
        let prefix = format!("tomb/{tomb}/");
        if logical_key != GLOBAL_KEY && !logical_key.starts_with(&prefix) {
            return Err(refused());
        }
        let leaf = modern_name(logical_key)?;
        let context = binding(logical_key, &leaf)?;
        let Some(mut held) = read_optional(&self.origin, &leaf)? else {
            self.check()?;
            return Ok(None);
        };
        held.validate()?;
        validate(
            &self.credential.state,
            NodeAtRestDomain::DeviceRecord,
            &context,
            held.bytes(),
        )?;
        held.validate()?;
        self.check()?;
        Ok(Some(held.bytes().to_vec()))
    }
}
impl NativeNodeDeviceInventory {
    /// Read one exact known retired slot for a tomb actually captured by the original catalogue.
    /// Credential-only DATA never authenticates a real root, factor, retired record or owner.
    /// # Errors
    /// Refuses uncatalogued tombs, absent slots, stale census, plaintext/invalid AEAD and IO failures.
    pub fn read_retired_ciphertext(&self, tomb: &str) -> io::Result<Vec<u8>> {
        self.read_optional_retired_ciphertext(tomb)?
            .ok_or_else(missing)
    }
    /// Observe exact known retired-slot absence from this original retained catalogue.
    /// # Errors
    /// Refuses uncatalogued tomb/present-file/stale roots and never converts arbitrary IO to absence.
    pub fn read_optional_retired_ciphertext(&self, tomb: &str) -> io::Result<Option<Vec<u8>>> {
        let _operation = gate(&self.credential.state.operations)?;
        self.check()?;
        self.vault(tomb)?;
        let logical = format!("tomb/{tomb}/retired-credentials.v2");
        let leaf = modern_name(&logical)?;
        let context = binding(&logical, &leaf)?;
        let Some(origin) = self.origin.as_ref() else {
            self.check()?;
            return Ok(None);
        };
        let Some(mut held) = read_optional(&origin.directory, &leaf)? else {
            self.check()?;
            return Ok(None);
        };
        held.validate()?;
        validate(
            &self.credential.state,
            NodeAtRestDomain::DeviceRecord,
            &context,
            held.bytes(),
        )?;
        held.validate()?;
        self.check()?;
        Ok(Some(held.bytes().to_vec()))
    }
}
#[cfg(test)]
#[path = "node_data_ciphertext_reads_tests.rs"]
mod tests;

#[path = "node_data_ciphertext_publications.rs"]
mod publications;
