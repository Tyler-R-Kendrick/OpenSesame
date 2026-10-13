//! Native retired-owner prerequisites. Public context metadata never grants authority.
use std::path::Path;

use crate::StoreError;

#[cfg(unix)]
#[path = "retired_native/owner.rs"]
mod owner;
#[cfg(unix)]
#[path = "retired_native/storage_unix.rs"]
mod storage;

/// Public read-only policy identity, never an owner permit, raw key or realm admission.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NativeRetiredPolicyView {
    pub vault_id: String,
    pub root_key_id: String,
    pub root_epoch: u64,
    pub revision: u64,
    pub selected_protector_id: String,
}

/// Inspect supported native policy through actual current credential and private storage.
/// No returned value can authorize enrollment, decrypt items or clear a synthetic realm;
/// future mutations must authenticate privately again on their original locked scope.
///
/// # Errors
/// Refuses unsupported policies/platforms, current authentication failure or changed storage.
pub fn inspect_native_retired_policy(
    root: &Path,
    current_password: &[u8],
) -> Result<NativeRetiredPolicyView, StoreError> {
    #[cfg(unix)]
    {
        owner::inspect(root, current_password)
    }
    #[cfg(not(unix))]
    {
        let _ = (root, current_password);
        Err(StoreError::Other(
            "native retired owner private storage is unsupported on this platform".into(),
        ))
    }
}

#[cfg(all(test, not(unix)))]
mod unsupported_tests {
    use super::*;

    #[test]
    fn unsupported_owner_storage_refuses_before_opening_a_profile_or_credential() {
        let temporary = tempfile::tempdir().unwrap();
        assert!(
            inspect_native_retired_policy(temporary.path(), b"provided current credential")
                .is_err()
        );
        assert_eq!(std::fs::read_dir(temporary.path()).unwrap().count(), 0);
    }
}
