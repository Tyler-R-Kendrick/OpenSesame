//! Explicitly installed standalone MCP detector. It never opens a real vault/key file.
use super::{
    failure,
    private_file::{self, Record},
};
use crate::{store_lock::StoreLock, StoreError};
use opensesame_human_vault::credential_canaries::{
    InstalledValidator, ValidatorBinding, MAX_REGISTRY_BYTES,
};
use std::path::Path;
/// # Errors
/// Requires an existing owner-private detector directory and explicit human binding installation.
pub fn install(
    directory: &Path,
    raw_binding: &str,
    replace: bool,
) -> Result<ValidatorBinding, StoreError> {
    private_file::supported()?;
    private_file::require_private_directory(directory)?;
    let _lock = StoreLock::key_file_edit(directory)?;
    let binding = ValidatorBinding::parse(raw_binding).map_err(failure)?;
    if private_file::read(directory, Record::Validator, MAX_REGISTRY_BYTES)?.is_some() && !replace {
        return Err(failure(
            "a validator is already installed; explicitly replace its binding",
        ));
    }
    let state = InstalledValidator::new(binding.clone()).map_err(failure)?;
    private_file::write(
        directory,
        Record::Validator,
        state.encode().map_err(failure)?.as_bytes(),
    )?;
    Ok(binding)
}
/// # Errors
/// Serializes processes and refreshes the owner-installed exact binding before every request.
pub fn handle(
    directory: &Path,
    validator_id: &str,
    presented_id: &str,
    request: &str,
) -> Result<Option<serde_json::Value>, StoreError> {
    private_file::supported()?;
    private_file::require_private_directory(directory)?;
    let _lock = StoreLock::key_file_edit(directory)?;
    let raw = private_file::read(directory, Record::Validator, MAX_REGISTRY_BYTES)?
        .ok_or_else(|| failure("no validator is installed"))?;
    let mut state =
        InstalledValidator::parse(std::str::from_utf8(&raw).map_err(failure)?, validator_id)
            .map_err(failure)?;
    let response = state
        .handle(presented_id, request, &super::now())
        .map_err(failure)?;
    private_file::write(
        directory,
        Record::Validator,
        state.encode().map_err(failure)?.as_bytes(),
    )?;
    Ok(response)
}
/// # Errors
/// Returns closed detector metadata to its explicit human operator; no token is persisted.
pub fn status(directory: &Path, validator_id: &str) -> Result<String, StoreError> {
    private_file::supported()?;
    private_file::require_private_directory(directory)?;
    let _lock = StoreLock::key_file_edit(directory)?;
    let raw = private_file::read(directory, Record::Validator, MAX_REGISTRY_BYTES)?
        .ok_or_else(|| failure("no validator is installed"))?;
    let state =
        InstalledValidator::parse(std::str::from_utf8(&raw).map_err(failure)?, validator_id)
            .map_err(failure)?;
    Ok(serde_json::json!({"binding":state.binding,"events":state.events}).to_string())
}
/// # Errors
/// Explicit owner-private removal validates the expected installed binding and never follows links.
pub fn uninstall(directory: &Path, validator_id: &str) -> Result<(), StoreError> {
    private_file::supported()?;
    private_file::require_private_directory(directory)?;
    let _lock = StoreLock::key_file_edit(directory)?;
    let raw = private_file::read(directory, Record::Validator, MAX_REGISTRY_BYTES)?
        .ok_or_else(|| failure("no validator is installed"))?;
    InstalledValidator::parse(std::str::from_utf8(&raw).map_err(failure)?, validator_id)
        .map_err(failure)?;
    private_file::remove(directory, Record::Validator)
}
