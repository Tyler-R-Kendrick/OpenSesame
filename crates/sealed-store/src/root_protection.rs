//! Store-root facade over human-vault root-protection (NATIVE).

use std::path::Path;

use base64::{engine::general_purpose::STANDARD, Engine};
use opensesame_human_vault::root_protection::{
    protect_add_age_recipient, protect_add_recovery, protect_list, protect_remove,
    protect_rewrap_password, protect_test_password, protect_test_recovery, ProtectionError,
    ProtectorSummary,
};

use crate::age_fmt::encrypt_age;
use crate::store_lock::StoreLock;
use crate::StoreError;

impl From<ProtectionError> for StoreError {
    fn from(value: ProtectionError) -> Self {
        match value {
            ProtectionError::Io(msg) => StoreError::Other(msg),
            other => StoreError::Crypto(other.to_string()),
        }
    }
}

/// List enrolled protectors (ids/kinds only).
///
/// # Errors
///
/// Returns store crypto errors when the key file cannot be read.
pub fn protect_list_store(root: &Path) -> Result<Vec<ProtectorSummary>, StoreError> {
    Ok(protect_list(root)?)
}

/// Test password unlock without printing secrets.
///
/// # Errors
///
/// Returns unlock failures.
pub fn protect_test_store_password(root: &Path, password: &[u8]) -> Result<(), StoreError> {
    Ok(protect_test_password(root, password)?)
}

/// Rewrap password protector without rotating the root (see
/// [`crate::rotate_store_root`] for the revoking form).
///
/// # Errors
///
/// Returns unlock/wrap failures.
pub fn protect_rewrap_store_password(
    root: &Path,
    old_password: &[u8],
    new_password: &[u8],
) -> Result<(), StoreError> {
    // One key-file edit at a time, and none while a rotation runs (its commit
    // would overwrite the edit).
    let _lock = StoreLock::key_file_edit(root)?;
    Ok(protect_rewrap_password(root, old_password, new_password)?)
}

/// Add recovery-key protector; returns secret bytes for one-time reveal by CLI.
///
/// # Errors
///
/// Returns unlock/wrap failures.
pub fn protect_add_store_recovery(
    root: &Path,
    password: &[u8],
) -> Result<([u8; 32], String), StoreError> {
    let _lock = StoreLock::key_file_edit(root)?;
    Ok(protect_add_recovery(root, password)?)
}

/// Remove protector by id without rotating the root (see
/// [`crate::rotate_store_root`] for the revoking form).
///
/// # Errors
///
/// Returns last-path and unlock failures.
pub fn protect_remove_store(
    root: &Path,
    password: &[u8],
    protector_id: &str,
) -> Result<(), StoreError> {
    let _lock = StoreLock::key_file_edit(root)?;
    Ok(protect_remove(root, password, protector_id)?)
}

/// Test recovery key.
///
/// # Errors
///
/// Returns capsule failures.
pub fn protect_test_store_recovery(root: &Path, recovery_key: &[u8; 32]) -> Result<(), StoreError> {
    Ok(protect_test_recovery(root, recovery_key)?)
}

/// Add age-recipient protector by encrypting a root capsule to recipients.
///
/// # Errors
///
/// Returns age or unlock failures.
pub fn protect_add_store_age_recipient(
    root: &Path,
    password: &[u8],
    recipients: &[String],
) -> Result<String, StoreError> {
    let _lock = StoreLock::key_file_edit(root)?;
    let (_, _, vrk) =
        opensesame_human_vault::root_protection::unlock_key_file_with_password(root, password)
            .map_err(StoreError::from)?;
    let capsule = encrypt_age(&vrk.0, recipients)?;
    let capsule_b64 = STANDARD.encode(capsule);
    Ok(protect_add_age_recipient(
        root,
        password,
        recipients.to_vec(),
        capsule_b64,
    )?)
}

#[cfg(test)]
mod tests {
    use opensesame_human_vault::root_protection::{write_key_file, KeyFileContents};
    use opensesame_human_vault::{wrap_vrk_with_password, ItemDataKey, VaultRootKey};

    use crate::entry::Entry;
    use crate::store::{init_store, unlock_store_key};

    #[test]
    fn legacy_opensesame_key_still_opens_osseal_kp03() {
        let dir = tempfile::tempdir().unwrap();
        let root = init_store(dir.path(), &[]).unwrap();
        let vrk = VaultRootKey::generate();
        let wrapper = wrap_vrk_with_password(b"correct horse", &vrk).unwrap();
        write_key_file(dir.path(), &KeyFileContents::Legacy(wrapper)).unwrap();
        let key = ItemDataKey(vrk.0);
        root.insert(
            "x",
            &Entry {
                secret: "v".into(),
                trailer: String::new(),
                otp: None,
            },
            &key,
        )
        .unwrap();
        let unlocked = unlock_store_key(dir.path(), b"correct horse").unwrap();
        assert_eq!(root.show("x", &unlocked).unwrap().secret, "v");
    }
}
