//! Owner-managed native traps and a typed synthetic read realm with no production key.
use crate::{path::confined_read_bounded, store_lock::StoreLock, ItemDataKey, StoreError};
use base64::{engine::general_purpose::STANDARD, Engine};
use opensesame_human_vault::root_protection::{
    load_key_file, unlock_key_file_with_password, KeyFileContents,
};
use opensesame_human_vault::{
    retired_credentials::{Records, Response, TrapRecord},
    VaultRootKey,
};
use std::path::Path;

pub const RETIRED_RECORD_FILE: &str = ".opensesame-retired-credentials.json";
mod persistence;
fn failure(error: impl std::fmt::Display) -> StoreError {
    StoreError::Other(error.to_string())
}
fn context(root: &Path) -> Result<String, StoreError> {
    match load_key_file(root).map_err(failure)? {
        KeyFileContents::Manifest(manifest) => Ok(format!("native-store:{}", manifest.vault_id)),
        KeyFileContents::Legacy(_) => Err(StoreError::Other(
            "retired traps require a versioned store key".into(),
        )),
    }
}
fn read(root: &Path) -> Result<Records, StoreError> {
    persistence::supported()?;
    let context = context(root)?;
    match confined_read_bounded(
        root,
        Path::new(RETIRED_RECORD_FILE),
        opensesame_human_vault::retired_credentials::MAX_RECORD_BYTES,
    ) {
        Ok(bytes) => {
            let text = std::str::from_utf8(&bytes).map_err(failure)?;
            Records::parse(text, &context).map_err(failure)
        }
        Err(StoreError::Io(error)) if error.kind() == std::io::ErrorKind::NotFound => {
            Ok(Records::new(&context))
        }
        Err(error) => Err(error),
    }
}
fn write(root: &Path, records: &Records) -> Result<(), StoreError> {
    let data = serde_json::to_vec(records).map_err(failure)?;
    if data.len() > opensesame_human_vault::retired_credentials::MAX_RECORD_BYTES {
        return Err(failure("retired credential records are unavailable"));
    }
    persistence::write(root, &data)
}
fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

/// Metadata only. A filesystem record does not authenticate its owner.
/// # Errors
/// Refuses symlinked, malformed or foreign-context records.
pub fn has_retired_traps(root: &Path) -> Result<bool, StoreError> {
    if !persistence::exists(root)? {
        return Ok(false);
    }
    Ok(!read(root)?.traps.is_empty())
}

/// Fresh owner authentication is required before enrollment, removal or evidence access.
/// # Errors
/// Refuses invalid owner credentials and malformed stored records.
pub fn retired_records_for_owner(
    root: &Path,
    current_password: &[u8],
) -> Result<Records, StoreError> {
    let _lock = StoreLock::key_file_edit(root)?;
    let _owner = unlock_key_file_with_password(root, current_password).map_err(failure)?;
    read(root)
}

/// # Errors
/// Refuses wrong owners, current password collisions, duplicates and unbounded enrollment.
pub fn enroll_retired_password(
    root: &Path,
    current: &[u8],
    retired: &[u8],
    response: Response,
) -> Result<TrapRecord, StoreError> {
    let _lock = StoreLock::key_file_edit(root)?;
    let _owner = unlock_key_file_with_password(root, current).map_err(failure)?;
    if unlock_key_file_with_password(root, retired).is_ok() {
        return Err(failure("retired credential enrollment is ambiguous"));
    }
    let mut records = read(root)?;
    let trap = records.enroll(retired, response, &now()).map_err(failure)?;
    write(root, &records)?;
    Ok(trap)
}

/// # Errors
/// Refuses wrong owners and invalid records; affects no production key or session.
pub fn remove_retired_password(root: &Path, current: &[u8], id: &str) -> Result<(), StoreError> {
    let _lock = StoreLock::key_file_edit(root)?;
    let _owner = unlock_key_file_with_password(root, current).map_err(failure)?;
    let mut records = read(root)?;
    records.traps.retain(|trap| trap.id != id);
    write(root, &records)
}

/// # Errors
/// Refuses wrong owners before clearing local evidence.
pub fn clear_retired_events(root: &Path, current: &[u8]) -> Result<(), StoreError> {
    let _lock = StoreLock::key_file_edit(root)?;
    let _owner = unlock_key_file_with_password(root, current).map_err(failure)?;
    let mut records = read(root)?;
    records.events.clear();
    write(root, &records)
}

/// # Errors
/// Refuses corrupt records or concurrent writers rather than skipping detection.
pub fn classify_retired_password(
    root: &Path,
    password: &[u8],
) -> Result<Option<TrapRecord>, StoreError> {
    if !persistence::exists(root)? {
        return Ok(None);
    }
    let _lock = StoreLock::key_file_edit(root)?;
    let mut records = read(root)?;
    let trap = records.probe(password).map_err(failure)?;
    if let Some(ref trap) = trap {
        records.observe(trap, &now()).map_err(failure)?;
        write(root, &records)?;
        if let Some(event) = records.events.last() {
            crate::credential_canaries::queue_password_under_edit(root, event);
        }
    }
    Ok(trap)
}

/// # Errors
/// Refuses password reuse while leaving retained trap records and evidence unchanged.
pub(crate) fn reject_retired_password_reuse(
    root: &Path,
    password: &[u8],
) -> Result<(), StoreError> {
    if !persistence::exists(root)? {
        return Ok(());
    }
    if read(root)?.probe(password).map_err(failure)?.is_some() {
        return Err(failure(
            "selected retired passwords cannot become current credentials",
        ));
    }
    Ok(())
}

/// An independent synthetic identity. It cannot be converted to a production `ItemDataKey`.
pub struct SyntheticReadRealm {
    principal: String,
    key: VaultRootKey,
}
impl SyntheticReadRealm {
    fn fresh() -> Self {
        Self {
            principal: uuid::Uuid::new_v4().to_string(),
            key: VaultRootKey::generate(),
        }
    }
    #[must_use]
    pub fn principal(&self) -> &str {
        &self.principal
    }
    #[must_use]
    pub fn names(&self, prefix: &str) -> Vec<String> {
        let name = "Example/account";
        if prefix.is_empty() || name == prefix || name.starts_with(&format!("{prefix}/")) {
            vec![name.into()]
        } else {
            Vec::new()
        }
    }
    /// No real entry name or content is consulted.
    /// # Errors
    /// Refuses names outside the synthetic inventory.
    pub fn show(&self, name: &str) -> Result<String, StoreError> {
        if name != "Example/account" {
            return Err(failure("entry not found"));
        }
        Ok(format!("synthetic-{}\nusername: member@example.invalid\nurl: https://account.example.invalid\n", STANDARD.encode(self.key.0)))
    }
    /// # Errors
    /// Always refuses production operations, exports, connectors and privilege upgrades.
    pub fn production_authority(&self) -> Result<(), StoreError> {
        Err(failure(
            "synthetic realms have no production authority; authenticate again",
        ))
    }
}

pub enum ReadAdmission {
    Real(ItemDataKey),
    Synthetic(SyntheticReadRealm),
}
/// # Errors
/// Never returns the protected root for a retired password; synthetic admission is read-only.
pub fn admit_store_read(root: &Path, password: &[u8]) -> Result<ReadAdmission, StoreError> {
    if let Some(trap) = classify_retired_password(root, password)? {
        return match trap.response {
            Response::Reject => Err(failure("that credential did not unlock the vault")),
            Response::SyntheticDecoy => Ok(ReadAdmission::Synthetic(SyntheticReadRealm::fresh())),
        };
    }
    let (key, _, _) = unlock_key_file_with_password(root, password).map_err(failure)?;
    Ok(ReadAdmission::Real(key))
}

#[cfg(test)]
mod tests;
