//! Original private native owner issuer. No metadata/key/boolean factory is exported.
use std::path::Path;

use opensesame_human_vault::root_protection::{
    assert_native_factor_configuration, parse_key_file_json, verify_manifest_auth, KeyFileContents,
    ProofStatus, ProtectionPurpose, ProtectionRecord, RootProtectionManifest,
};
use opensesame_human_vault::{unwrap_vrk_with_password, VaultRootKey};

use super::{storage::ScopedStore, NativeRetiredPolicyView};
use crate::StoreError;

fn unsupported() -> StoreError {
    StoreError::Other("native retired owner policy is unsupported".into())
}

fn auth_failed() -> StoreError {
    StoreError::Other("native retired owner authentication failed".into())
}

fn storage_failed() -> StoreError {
    StoreError::Other("native retired owner original storage is unavailable or changed".into())
}

// Neither this type nor its issuer leaves this original module.
struct NativeOwner {
    storage: ScopedStore,
    manifest: RootProtectionManifest,
    root: VaultRootKey,
}

fn selected_password(
    manifest: &RootProtectionManifest,
) -> Result<&opensesame_human_vault::PasswordWrapper, StoreError> {
    if manifest.purpose != ProtectionPurpose::HumanVaultRoot
        || manifest.root_epoch == 0
        || manifest.revision == 0
        || manifest.vault_id.is_empty()
        || manifest.vault_id.len() > 256
        || manifest.root_key_id.is_empty()
        || manifest.root_key_id.len() > 256
        || manifest.records.len() != 1
        || manifest.factor_configuration.is_none()
        || manifest.legacy_gates.as_ref().is_some_and(|gates| {
            gates.totp_enrolled
                || gates.email_enrolled
                || gates.sms_enrolled
                || gates.recovery_codes_enrolled
        })
    {
        return Err(unsupported());
    }
    let ProtectionRecord::Password {
        protector_id,
        wrapper,
        proof_status,
        ..
    } = &manifest.records[0]
    else {
        return Err(unsupported());
    };
    if protector_id.is_empty()
        || protector_id.len() > 128
        || *proof_status != ProofStatus::Verified
        || manifest.preferred_protector_id.as_deref() != Some(protector_id.as_str())
    {
        return Err(unsupported());
    }
    Ok(wrapper)
}

impl NativeOwner {
    fn admit(root: &Path, current_password: &[u8]) -> Result<Self, StoreError> {
        if current_password.is_empty()
            || current_password.len() > 4096
            || std::str::from_utf8(current_password).is_err()
        {
            return Err(unsupported());
        }
        let (storage, bytes) = ScopedStore::open(root).map_err(|_| storage_failed())?;
        let text = std::str::from_utf8(&bytes).map_err(|_| auth_failed())?;
        let contents = parse_key_file_json(text).map_err(|_| auth_failed())?;
        let KeyFileContents::Manifest(manifest) = contents else {
            // An unsigned legacy wrap needs completed authenticated migration, then fresh admission.
            return Err(unsupported());
        };
        let wrapper = selected_password(&manifest)?;
        let root =
            unwrap_vrk_with_password(current_password, wrapper).map_err(|_| auth_failed())?;
        verify_manifest_auth(&root, &manifest).map_err(|_| auth_failed())?;
        assert_native_factor_configuration(&manifest).map_err(|_| auth_failed())?;
        let mut admitted = Self {
            storage,
            manifest,
            root,
        };
        admitted.revalidate()?;
        Ok(admitted)
    }

    fn revalidate(&mut self) -> Result<(), StoreError> {
        self.storage.validate().map_err(|_| storage_failed())?;
        selected_password(&self.manifest)?;
        verify_manifest_auth(&self.root, &self.manifest).map_err(|_| auth_failed())?;
        assert_native_factor_configuration(&self.manifest).map_err(|_| auth_failed())
    }

    fn view(&mut self) -> Result<NativeRetiredPolicyView, StoreError> {
        self.revalidate()?;
        Ok(NativeRetiredPolicyView {
            vault_id: self.manifest.vault_id.clone(),
            root_key_id: self.manifest.root_key_id.clone(),
            root_epoch: self.manifest.root_epoch,
            revision: self.manifest.revision,
            selected_protector_id: self.manifest.records[0].protector_id().to_owned(),
        })
    }
}

pub(super) fn inspect(
    root: &Path,
    current_password: &[u8],
) -> Result<NativeRetiredPolicyView, StoreError> {
    NativeOwner::admit(root, current_password)?.view()
}

#[cfg(test)]
#[path = "owner_tests.rs"]
mod tests;
