//! Root rotation planning: mint a new vault root key and rewrap every
//! protector that can be moved to it — without writing anything.
//!
//! The native store seals content directly under the root key
//! (`ItemDataKey(vrk.0)`), so a rotation is only correct once every entry and
//! attachment has been re-encrypted. That is the store layer's job; this module
//! hands it both keys and a manifest that is already sealed under the new root,
//! and the store writes the key file last.

use std::path::Path;

use zeroize::Zeroize;

use crate::password_wrap::{unwrap_vrk_with_password, wrap_vrk_with_password};
use crate::VaultRootKey;

use super::auth::{seal_manifest_auth, verify_manifest_auth};
use super::error::ProtectionError;
use super::key_file::{load_key_file, password_wrapper_from_manifest};
use super::ops::{ensure_versioned_manifest, remove_record};
use super::recovery::{generate_recovery_key, wrap_vrk_with_recovery_key};
use super::types::{ProofStatus, ProtectionRecord, RootProtectionManifest};

/// What changes alongside the new root key.
#[derive(Clone, Copy, Default)]
pub struct RotationEdit<'a> {
    /// Wrap the password protector under this passphrase instead of the one
    /// that unlocked the store (`pass protect rewrap`).
    pub new_password: Option<&'a [u8]>,
    /// Drop this protector before rewrapping the rest (`pass protect remove`).
    pub remove_protector: Option<&'a str>,
    /// Replace every recovery-key protector with a freshly generated one. A
    /// recovery wrap cannot follow the root without its secret, which is never
    /// stored, so a rotation refuses unless the caller consents to reissuing.
    pub reissue_recovery: bool,
}

/// A recovery key minted by a rotation. The caller shows it once.
pub struct ReissuedRecovery {
    pub protector_id: String,
    pub secret: [u8; 32],
    pub fingerprint_b64: String,
}

impl Drop for ReissuedRecovery {
    fn drop(&mut self) {
        self.secret.zeroize();
    }
}

/// Both roots and the next manifest, already sealed under the new root.
pub struct PreparedRotation {
    pub old_vrk: VaultRootKey,
    pub new_vrk: VaultRootKey,
    pub manifest: RootProtectionManifest,
    pub reissued_recovery: Vec<ReissuedRecovery>,
}

/// Seals a root capsule to age recipients. The store layer owns age, so it
/// supplies this; it returns the capsule as base64.
pub type CapsuleSealer<'a> =
    &'a dyn Fn(&VaultRootKey, &[String]) -> Result<String, ProtectionError>;

/// Plan a root rotation for the key file under `root`.
///
/// Nothing is written. The password protector that unlocked the store is
/// rewrapped (under `edit.new_password` when given), age and PIV capsules are
/// resealed to their recorded recipients, and recovery keys are reissued only
/// with consent. A password protector other than the one that unlocked cannot
/// be rewrapped without its passphrase, so the plan refuses rather than drop it.
///
/// # Errors
///
/// Returns unlock failures, `LastVerifiedPath` for a removal that would lock
/// the owner out, and `Unavailable` for a protector that cannot follow.
pub fn prepare_root_rotation(
    root: &Path,
    password: &[u8],
    edit: RotationEdit<'_>,
    seal_capsule: CapsuleSealer<'_>,
) -> Result<PreparedRotation, ProtectionError> {
    let (old_vrk, mut manifest) = ensure_versioned_manifest(password, load_key_file(root)?)?;
    let unlocking_id = manifest
        .records
        .iter()
        .find(|r| matches!(r, ProtectionRecord::Password { .. }))
        .map(|r| r.protector_id().to_string())
        .ok_or(ProtectionError::ProtectorNotFound)?;
    if let Some(id) = edit.remove_protector {
        remove_record(&mut manifest, id)?;
    }
    let new_vrk = VaultRootKey::generate();
    let passphrase = edit.new_password.unwrap_or(password);
    let mut reissued = Vec::new();
    for record in &mut manifest.records {
        rewrap_record(
            record,
            &new_vrk,
            &Rewrap {
                unlocking_id: &unlocking_id,
                passphrase,
                reissue_recovery: edit.reissue_recovery,
                seal_capsule,
            },
            &mut reissued,
        )?;
    }
    if !manifest
        .records
        .iter()
        .any(|r| r.protector_id() == unlocking_id)
    {
        // The unlocking record was removed: another password record exists
        // (remove_record guarantees it), but its passphrase is not ours to
        // rewrap, so it could not have followed the root.
        return Err(ProtectionError::Unavailable(
            "the passphrase that unlocked the store is the one being removed; \
             unlock with the passphrase that stays"
                .into(),
        ));
    }
    manifest.root_epoch = manifest.root_epoch.saturating_add(1);
    manifest.root_key_id = uuid::Uuid::new_v4().to_string();
    manifest.revision = manifest.revision.saturating_add(1);
    seal_manifest_auth(&new_vrk, &mut manifest)?;
    // Prove the plan opens before anyone re-encrypts a byte under it.
    let reopened =
        unwrap_vrk_with_password(passphrase, password_wrapper_from_manifest(&manifest)?)?;
    verify_manifest_auth(&reopened, &manifest)?;
    if reopened.0 != new_vrk.0 {
        return Err(ProtectionError::Crypto);
    }
    Ok(PreparedRotation {
        old_vrk,
        new_vrk,
        manifest,
        reissued_recovery: reissued,
    })
}

struct Rewrap<'a> {
    unlocking_id: &'a str,
    passphrase: &'a [u8],
    reissue_recovery: bool,
    seal_capsule: CapsuleSealer<'a>,
}

fn rewrap_record(
    record: &mut ProtectionRecord,
    new_vrk: &VaultRootKey,
    how: &Rewrap<'_>,
    reissued: &mut Vec<ReissuedRecovery>,
) -> Result<(), ProtectionError> {
    match record {
        ProtectionRecord::Password {
            protector_id,
            wrapper,
            proof_status,
            ..
        } => {
            if protector_id != how.unlocking_id {
                return Err(ProtectionError::Unavailable(format!(
                    "password protector {protector_id} cannot follow a new root without its \
                     passphrase; remove it first"
                )));
            }
            *wrapper = wrap_vrk_with_password(how.passphrase, new_vrk)?;
            *proof_status = ProofStatus::Verified;
        }
        ProtectionRecord::AgeRecipient {
            recipients,
            capsule_age_b64,
            proof_status,
            ..
        } => {
            *capsule_age_b64 = (how.seal_capsule)(new_vrk, recipients)?;
            *proof_status = ProofStatus::Untested;
        }
        ProtectionRecord::YubikeyPivAge {
            recipient,
            capsule_age_b64,
            proof_status,
            ..
        } => {
            *capsule_age_b64 = (how.seal_capsule)(new_vrk, std::slice::from_ref(recipient))?;
            *proof_status = ProofStatus::Untested;
        }
        ProtectionRecord::RecoveryKey {
            protector_id,
            wrap,
            fingerprint_b64,
            proof_status,
            ..
        } => {
            if !how.reissue_recovery {
                return Err(ProtectionError::Unavailable(format!(
                    "recovery key {protector_id} cannot follow a new root (its secret is not \
                     stored); consent to reissuing it, or remove it first"
                )));
            }
            let secret = generate_recovery_key();
            let (new_wrap, fingerprint) = wrap_vrk_with_recovery_key(&secret, new_vrk)?;
            *wrap = new_wrap;
            fingerprint_b64.clone_from(&fingerprint);
            *proof_status = ProofStatus::Verified;
            reissued.push(ReissuedRecovery {
                protector_id: protector_id.clone(),
                secret,
                fingerprint_b64: fingerprint,
            });
        }
    }
    Ok(())
}
