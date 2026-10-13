//! Fresh native password-root generation; no caller-provided root-key issuer.
#[cfg(unix)]
use super::unix_private_files::{write_new, PrivateDirectory};
#[cfg(windows)]
use super::windows_private_files::{write_new, PrivateDirectory};
use super::{
    native_factor_configuration::seal_for_native_producer, ProofStatus, ProtectionError,
    ProtectionPurpose, ProtectionRecord, RootProtectionManifest, MANIFEST_SCHEMA_VERSION,
};
use crate::{wrap_vrk_with_password, VaultRootKey};

pub(super) fn prepare(
    password: &[u8],
) -> Result<(VaultRootKey, RootProtectionManifest), ProtectionError> {
    let vrk = VaultRootKey::generate();
    let wrapper = wrap_vrk_with_password(password, &vrk)?;
    let vault_id = uuid::Uuid::new_v4().to_string();
    let root_key_id = uuid::Uuid::new_v4().to_string();
    let protector_id = uuid::Uuid::new_v4().to_string();
    let mut manifest = RootProtectionManifest {
        schema_version: MANIFEST_SCHEMA_VERSION,
        vault_id,
        root_key_id,
        root_epoch: 1,
        revision: 1,
        purpose: ProtectionPurpose::HumanVaultRoot,
        records: vec![ProtectionRecord::Password {
            protector_id: protector_id.clone(),
            legacy: true,
            wrapper,
            proof_status: ProofStatus::Verified,
            last_evidence: None,
        }],
        preferred_protector_id: Some(protector_id),
        legacy_gates: None,
        auth_b64: None,
        factor_configuration: None,
    };
    seal_for_native_producer(&vrk, &mut manifest)?;
    Ok((vrk, manifest))
}

/// Create a new signed native password root through a retained private directory.
/// Its key file receives the owner-private descriptor before its first byte.
/// The supplied password protects a newly generated root, never an existing root.
/// This does not enroll traps, copy old data, or issue transferable owner authority.
///
/// # Errors
/// Refuses invalid native passwords, existing key files, unsupported private storage,
/// derivation, encoding and IO failures. A private empty root can remain on failure.
#[cfg(any(unix, windows))]
pub fn init_private_versioned_key_file(
    directory: &PrivateDirectory,
    password: &[u8],
) -> Result<(crate::ItemDataKey, RootProtectionManifest), ProtectionError> {
    if password.is_empty() || password.len() > 4096 || std::str::from_utf8(password).is_err() {
        return Err(ProtectionError::ContextMismatch);
    }
    let (root, manifest) = prepare(password)?;
    let encoded = super::encode_key_file(&super::KeyFileContents::Manifest(manifest.clone()))?;
    write_new(
        directory,
        std::path::Path::new(super::KEY_FILE_NAME),
        encoded.as_bytes(),
    )?;
    Ok((crate::ItemDataKey(root.0), manifest))
}

#[cfg(all(test, windows))]
#[path = "new_password_root_windows_tests.rs"]
mod windows_tests;

#[cfg(all(test, unix))]
#[path = "new_password_root_unix_tests.rs"]
mod unix_tests;
