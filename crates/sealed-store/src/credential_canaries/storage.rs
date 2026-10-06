use super::{
    failure,
    private_file::{self, Record},
};
use crate::{store_lock::StoreLock, StoreError};
use opensesame_human_vault::{
    credential_canaries::{DeviceState, MAX_DEVICE_STATE_BYTES},
    root_protection::{load_key_file, unlock_key_file_with_password, KeyFileContents},
    AssociatedData, EncryptedEnvelope, ItemDataKey,
};
use rand::RngCore;
use std::path::Path;
use zeroize::Zeroizing;
const MAX_SEALED_BYTES: usize = 196608;
fn identity(root: &Path) -> Result<String, StoreError> {
    match load_key_file(root).map_err(failure)? {
        KeyFileContents::Manifest(manifest) => Ok(manifest.vault_id),
        KeyFileContents::Legacy(_) => Err(failure(
            "canaries require a versioned stable store identity",
        )),
    }
}
fn associated(identity: &str) -> AssociatedData {
    AssociatedData {
        envelope_version: 1,
        item_id: "credential-observation-device-state.v1".into(),
        organization_id: "local-device-detector".into(),
        project_id: identity.into(),
        collection_id: "closed-credential-observations".into(),
        key_id: "independent-device-key.v1".into(),
        revision: 1,
    }
}
fn key(root: &Path, allow_create: bool, state_exists: bool) -> Result<ItemDataKey, StoreError> {
    if let Some(raw) = private_file::read(root, Record::Key, 32)? {
        let raw = Zeroizing::new(raw);
        let key = raw
            .as_slice()
            .try_into()
            .map_err(|_| failure("independent detector key is unavailable"))?;
        return Ok(ItemDataKey(key));
    }
    if !allow_create || state_exists {
        return Err(failure("independent detector key is unavailable"));
    }
    let mut value = ItemDataKey([0u8; 32]);
    rand::thread_rng().fill_bytes(&mut value.0);
    private_file::write(root, Record::Key, &value.0)?;
    Ok(value)
}
pub(super) struct ProtectedState {
    pub state: DeviceState,
    key: ItemDataKey,
}
impl ProtectedState {
    pub(super) fn read(root: &Path, allow_create: bool) -> Result<Self, StoreError> {
        private_file::supported()?;
        let identity = identity(root)?;
        let tomb = format!("native-store:{identity}");
        let encrypted = private_file::read(root, Record::State, MAX_SEALED_BYTES)?;
        let key = key(root, allow_create, encrypted.is_some())?;
        let state = if let Some(raw) = encrypted {
            let envelope: EncryptedEnvelope = serde_json::from_slice(&raw).map_err(failure)?;
            let clear = Zeroizing::new(
                opensesame_human_vault::decrypt_item_with_ad(
                    &key,
                    &envelope,
                    &associated(&identity),
                )
                .map_err(failure)?,
            );
            let raw = std::str::from_utf8(&clear).map_err(failure)?;
            DeviceState::parse(raw, &tomb, &identity).map_err(failure)?
        } else {
            DeviceState::new(&tomb, &identity)
        };
        Ok(Self { state, key })
    }
    pub(super) fn write(&self, root: &Path) -> Result<(), StoreError> {
        self.state
            .validate(
                &self.state.registry.tomb,
                &self.state.registry.vault_identity,
            )
            .map_err(failure)?;
        let clear = Zeroizing::new(self.state.encode().map_err(failure)?);
        if clear.len() > MAX_DEVICE_STATE_BYTES {
            return Err(failure("detector state retention exceeded"));
        }
        let envelope = opensesame_human_vault::encrypt_item(
            &self.key,
            clear.as_bytes(),
            associated(&self.state.registry.vault_identity),
        )
        .map_err(failure)?;
        let bytes = serde_json::to_vec(&envelope).map_err(failure)?;
        if bytes.len() > MAX_SEALED_BYTES {
            return Err(failure("sealed detector state retention exceeded"));
        }
        private_file::write(root, Record::State, &bytes)
    }
}
pub(super) fn owner_edit<T>(
    root: &Path,
    current: &[u8],
    work: impl FnOnce(&mut DeviceState) -> Result<T, StoreError>,
) -> Result<T, StoreError> {
    let _lock = StoreLock::key_file_edit(root)?;
    let _owner = unlock_key_file_with_password(root, current).map_err(failure)?;
    let mut protected = ProtectedState::read(root, true)?;
    let result = work(&mut protected.state)?;
    protected.write(root)?;
    Ok(result)
}
