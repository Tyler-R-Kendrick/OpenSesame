//! Complete authenticated owner manifest freshness, checked only for pending owner tests.
use super::failure;
use crate::StoreError;
use opensesame_human_vault::{
    credential_canaries::DeviceState,
    root_protection::{load_key_file, KeyFileContents},
};
use std::path::Path;
fn policy(root: &Path) -> Result<Vec<u8>, StoreError> {
    let KeyFileContents::Manifest(manifest) = load_key_file(root).map_err(failure)? else {
        return Err(failure(
            "testing requires the original authenticated owner manifest",
        ));
    };
    serde_json::to_vec(&manifest).map_err(failure)
}
pub(super) fn pin(
    root: &Path,
    state: &mut DeviceState,
    package_id: String,
) -> Result<(), StoreError> {
    state
        .pin_owner_test(&package_id, &policy(root)?)
        .map_err(failure)
}
pub(super) fn current(
    root: &Path,
    state: &DeviceState,
    package_id: &str,
) -> Result<bool, StoreError> {
    Ok(state.owner_test_current(package_id, &policy(root)?))
}
