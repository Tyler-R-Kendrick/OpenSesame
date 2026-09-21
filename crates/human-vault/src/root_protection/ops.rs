//! Human root-protection mutations (list/add/test/remove/rewrap/recovery/rotate).

use crate::password_wrap::{unwrap_vrk_with_password, wrap_vrk_with_password};
use crate::VaultRootKey;

use super::auth::{seal_manifest_auth, verify_manifest_auth};
use super::error::ProtectionError;
use super::key_file::{
    list_protector_summaries, load_key_file, password_wrapper_from_manifest, write_key_file,
    KeyFileContents,
};
use super::limits::MANIFEST_SCHEMA_VERSION;
use super::recovery::{
    fingerprint_recovery_key, generate_recovery_key, unwrap_vrk_with_recovery_key,
    wrap_vrk_with_recovery_key,
};
use super::types::{
    ProofStatus, ProtectionPurpose, ProtectionRecord, ProtectorSummary, RootProtectionManifest,
};

/// Ensure contents are a mutable versioned manifesto, migrating legacy if needed.
///
/// # Errors
///
/// Returns crypto failures when migrating a legacy wrapper.
pub fn ensure_versioned_manifest(
    password: &[u8],
    contents: KeyFileContents,
) -> Result<(VaultRootKey, RootProtectionManifest), ProtectionError> {
    match contents {
        KeyFileContents::Manifest(manifest) => {
            if manifest.schema_version != MANIFEST_SCHEMA_VERSION {
                return Err(ProtectionError::UnsupportedVersion(manifest.schema_version));
            }
            let wrapper = password_wrapper_from_manifest(&manifest)?;
            let vrk = unwrap_vrk_with_password(password, wrapper)?;
            verify_manifest_auth(&vrk, &manifest)?;
            Ok((vrk, manifest))
        }
        KeyFileContents::Legacy(wrapper) => {
            let vrk = unwrap_vrk_with_password(password, &wrapper)?;
            let mut manifest = RootProtectionManifest {
                schema_version: MANIFEST_SCHEMA_VERSION,
                vault_id: uuid::Uuid::new_v4().to_string(),
                root_key_id: uuid::Uuid::new_v4().to_string(),
                root_epoch: 1,
                revision: 1,
                purpose: ProtectionPurpose::HumanVaultRoot,
                records: vec![ProtectionRecord::Password {
                    protector_id: uuid::Uuid::new_v4().to_string(),
                    legacy: true,
                    wrapper,
                    proof_status: ProofStatus::Verified,
                    last_evidence: None,
                }],
                preferred_protector_id: None,
                legacy_gates: None,
                auth_b64: None,
            };
            if let Some(ProtectionRecord::Password { protector_id, .. }) = manifest.records.first()
            {
                manifest.preferred_protector_id = Some(protector_id.clone());
            }
            seal_manifest_auth(&vrk, &mut manifest)?;
            Ok((vrk, manifest))
        }
    }
}

/// List protector summaries for a store root (no secrets).
///
/// # Errors
///
/// Returns key-file load failures.
pub fn protect_list(root: &std::path::Path) -> Result<Vec<ProtectorSummary>, ProtectionError> {
    let contents = load_key_file(root)?;
    Ok(list_protector_summaries(&contents))
}

/// Test that `password` opens the store root.
///
/// # Errors
///
/// Returns unlock failures without printing secrets.
pub fn protect_test_password(
    root: &std::path::Path,
    password: &[u8],
) -> Result<(), ProtectionError> {
    let _ = super::key_file::unlock_key_file_with_password(root, password)?;
    Ok(())
}

/// Rewrap the password protector under a new password (same VRK).
///
/// # Errors
///
/// Returns unlock/wrap failures.
pub fn protect_rewrap_password(
    root: &std::path::Path,
    old_password: &[u8],
    new_password: &[u8],
) -> Result<(), ProtectionError> {
    let contents = load_key_file(root)?;
    let (vrk, mut manifest) = ensure_versioned_manifest(old_password, contents)?;
    let new_wrapper = wrap_vrk_with_password(new_password, &vrk)?;
    let mut replaced = false;
    for record in &mut manifest.records {
        if let ProtectionRecord::Password {
            wrapper,
            proof_status,
            ..
        } = record
        {
            *wrapper = new_wrapper.clone();
            *proof_status = ProofStatus::Verified;
            replaced = true;
            break;
        }
    }
    if !replaced {
        return Err(ProtectionError::ProtectorNotFound);
    }
    manifest.revision = manifest.revision.saturating_add(1);
    seal_manifest_auth(&vrk, &mut manifest)?;
    write_key_file(root, &KeyFileContents::Manifest(manifest))?;
    Ok(())
}

/// Add a recovery-key protector. Returns the recovery secret once (caller must
/// handle display policy — libraries never print).
///
/// # Errors
///
/// Returns unlock/wrap failures.
pub fn protect_add_recovery(
    root: &std::path::Path,
    password: &[u8],
) -> Result<([u8; 32], String), ProtectionError> {
    let contents = load_key_file(root)?;
    let (vrk, mut manifest) = ensure_versioned_manifest(password, contents)?;
    let recovery = generate_recovery_key();
    let (wrap, fingerprint) = wrap_vrk_with_recovery_key(&recovery, &vrk)?;
    let protector_id = uuid::Uuid::new_v4().to_string();
    manifest.records.push(ProtectionRecord::RecoveryKey {
        protector_id,
        wrap,
        fingerprint_b64: fingerprint.clone(),
        proof_status: ProofStatus::Verified,
        last_evidence: None,
    });
    manifest.revision = manifest.revision.saturating_add(1);
    seal_manifest_auth(&vrk, &mut manifest)?;
    write_key_file(root, &KeyFileContents::Manifest(manifest))?;
    Ok((recovery, fingerprint))
}

/// Remove a protector by id. Refuses removing the last password/recovery path
/// when it would leave the vault unopenable by known software methods.
///
/// # Errors
///
/// Returns `LastVerifiedPath` when removal would brick the vault.
pub fn protect_remove(
    root: &std::path::Path,
    password: &[u8],
    protector_id: &str,
) -> Result<(), ProtectionError> {
    let contents = load_key_file(root)?;
    let (vrk, mut manifest) = ensure_versioned_manifest(password, contents)?;
    let before = manifest.records.len();
    let target_is_password = manifest.records.iter().any(|r| {
        matches!(r, ProtectionRecord::Password { protector_id: id, .. } if id == protector_id)
    });
    let password_count = manifest
        .records
        .iter()
        .filter(|r| matches!(r, ProtectionRecord::Password { .. }))
        .count();
    let soft_count = manifest
        .records
        .iter()
        .filter(|r| {
            matches!(
                r,
                ProtectionRecord::Password { .. } | ProtectionRecord::RecoveryKey { .. }
            )
        })
        .count();
    if target_is_password && password_count <= 1 && soft_count <= 1 {
        return Err(ProtectionError::LastVerifiedPath);
    }
    manifest
        .records
        .retain(|r| r.protector_id() != protector_id);
    if manifest.records.len() == before {
        return Err(ProtectionError::ProtectorNotFound);
    }
    if let Some(pref) = manifest.preferred_protector_id.as_deref() {
        if pref == protector_id {
            manifest.preferred_protector_id =
                manifest.records.first().map(|r| r.protector_id().to_string());
        }
    }
    manifest.revision = manifest.revision.saturating_add(1);
    seal_manifest_auth(&vrk, &mut manifest)?;
    write_key_file(root, &KeyFileContents::Manifest(manifest))?;
    Ok(())
}

/// Test a recovery key opens the manifest (no secret printed).
///
/// # Errors
///
/// Returns capsule failures when the recovery key is wrong.
pub fn protect_test_recovery(
    root: &std::path::Path,
    recovery_key: &[u8; 32],
) -> Result<(), ProtectionError> {
    let contents = load_key_file(root)?;
    let KeyFileContents::Manifest(manifest) = contents else {
        return Err(ProtectionError::ProtectorNotFound);
    };
    let fp = fingerprint_recovery_key(recovery_key);
    for record in &manifest.records {
        if let ProtectionRecord::RecoveryKey {
            wrap,
            fingerprint_b64,
            ..
        } = record
        {
            if fingerprint_b64 != &fp {
                continue;
            }
            let vrk = unwrap_vrk_with_recovery_key(recovery_key, wrap)?;
            verify_manifest_auth(&vrk, &manifest)?;
            return Ok(());
        }
    }
    Err(ProtectionError::ProtectorNotFound)
}

/// Rotate the root key: rewrap every software protector under a new VRK.
/// Entry ciphertext is NOT rewritten here — callers must re-seal store entries
/// when content keys change. This native store still uses `ItemDataKey(vrk.0)`,
/// so root rotation requires a store-wide rebind (LIFECYCLE owns that).
///
/// This function only rotates the key-file epoch and password/recovery wraps
/// when `allow_content_key_change` is true, returning the new content key.
///
/// # Errors
///
/// Returns unlock/wrap failures, or `Unavailable` when rotation would change
/// content keys without deliberate consent.
pub fn protect_root_rotate(
    root: &std::path::Path,
    password: &[u8],
    allow_content_key_change: bool,
) -> Result<VaultRootKey, ProtectionError> {
    if !allow_content_key_change {
        return Err(ProtectionError::Unavailable(
            "root-rotate changes ItemDataKey(vrk.0); pass --allow-content-key-change".into(),
        ));
    }
    let contents = load_key_file(root)?;
    let (_old_vrk, mut manifest) = ensure_versioned_manifest(password, contents)?;
    let new_vrk = VaultRootKey::generate();
    let new_password_wrapper = wrap_vrk_with_password(password, &new_vrk)?;
    for record in &mut manifest.records {
        match record {
            ProtectionRecord::Password {
                wrapper,
                proof_status,
                ..
            } => {
                *wrapper = new_password_wrapper.clone();
                *proof_status = ProofStatus::Stale;
            }
            ProtectionRecord::RecoveryKey { .. }
            | ProtectionRecord::AgeRecipient { .. }
            | ProtectionRecord::YubikeyPivAge { .. } => {
                return Err(ProtectionError::Unavailable(
                    "root-rotate currently supports password-only manifests; remove age/recovery first or use lifecycle rebind".into(),
                ));
            }
        }
    }
    manifest.root_epoch = manifest.root_epoch.saturating_add(1);
    manifest.root_key_id = uuid::Uuid::new_v4().to_string();
    manifest.revision = manifest.revision.saturating_add(1);
    seal_manifest_auth(&new_vrk, &mut manifest)?;
    write_key_file(root, &KeyFileContents::Manifest(manifest))?;
    Ok(new_vrk)
}

/// Add an age-recipient protector record (capsule already age-encrypted).
///
/// # Errors
///
/// Returns unlock failures or bounds errors.
pub fn protect_add_age_recipient(
    root: &std::path::Path,
    password: &[u8],
    recipients: Vec<String>,
    capsule_age_b64: String,
) -> Result<String, ProtectionError> {
    let contents = load_key_file(root)?;
    let (vrk, mut manifest) = ensure_versioned_manifest(password, contents)?;
    let protector_id = uuid::Uuid::new_v4().to_string();
    manifest.records.push(ProtectionRecord::AgeRecipient {
        protector_id: protector_id.clone(),
        recipients,
        capsule_age_b64,
        proof_status: ProofStatus::Untested,
        last_evidence: None,
    });
    manifest.revision = manifest.revision.saturating_add(1);
    seal_manifest_auth(&vrk, &mut manifest)?;
    write_key_file(root, &KeyFileContents::Manifest(manifest))?;
    Ok(protector_id)
}
