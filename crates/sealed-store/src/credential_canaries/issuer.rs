//! Separately authenticated trusted issuer retirement; no raw vendor identifier enrollment.
use super::{failure, storage};
use crate::{store_lock::StoreLock, StoreError};
use opensesame_human_vault::{
    credential_canaries::Artifact,
    root_protection::{load_key_file, unlock_key_file_with_password, KeyFileContents},
};
use std::path::Path;

/// An explicit operator-installed provider authenticates the Host independently, resolves its
/// persisted issuance UUID, and atomically revokes production authority before returning metadata.
pub trait TrustedIssuerProvider {
    /// # Errors
    /// Refuses absent Host authorization, unissued records or incomplete production revocation.
    fn retire_authenticated(
        &self,
        issuer_record_ref: &str,
        expected_vault_identity: &str,
    ) -> Result<Artifact, StoreError>;
}
/// # Errors
/// The caller's fresh current password grants only local management, never Host authorization.
/// No edit lock/root keys are retained during independent issuer transport; identity is checked
/// again under the owner edit lock before committing the returned digest-only artifact.
pub fn retire_issued(
    root: &Path,
    current: &[u8],
    issuer_record_ref: &str,
    provider: &dyn TrustedIssuerProvider,
) -> Result<(), StoreError> {
    super::private_file::supported()?;
    uuid::Uuid::parse_str(issuer_record_ref).map_err(failure)?;
    let original = {
        let _lock = StoreLock::key_file_edit(root)?;
        let _ = unlock_key_file_with_password(root, current).map_err(failure)?;
        let KeyFileContents::Manifest(manifest) = load_key_file(root).map_err(failure)? else {
            return Err(failure(
                "issued retirement requires a stable store identity",
            ));
        };
        manifest
    };
    let identity = original.vault_id.clone();
    let artifact = provider.retire_authenticated(issuer_record_ref, &identity)?;
    storage::owner_edit(root, current, |state| {
        let KeyFileContents::Manifest(current_manifest) = load_key_file(root).map_err(failure)?
        else {
            return Err(failure("original issuer root manifest changed"));
        };
        if current_manifest != original || state.registry.vault_identity != identity {
            return Err(failure("original issuer context changed"));
        }
        state
            .registry
            .import_verified_retirement(issuer_record_ref, artifact)
            .map_err(failure)
    })
}
