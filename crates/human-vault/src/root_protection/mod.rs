//! Shared vault root-protection model (browser + native).

mod auth;
mod canonicalize;
mod capsule;
mod cloud;
mod error;
mod factor_configuration;
mod key_file;
mod legacy;
mod limits;
mod native_factor_configuration;
mod new_password_root;
mod ops;
mod parse;
mod recovery;
mod rotation;
mod types;

#[cfg(test)]
mod factor_configuration_tests;
#[cfg(test)]
mod tests;

pub use auth::{seal_manifest_auth, verify_manifest_auth};
pub use canonicalize::canonicalize_to_bytes;
pub use capsule::{open_root_capsule, seal_root_capsule, ProtectionContext, SealedBlobV1};
pub use cloud::{
    create_cloud_local_envelope, derive_local_kek, open_cloud_local_envelope, CloudLocalEnvelope,
};
pub use error::ProtectionError;
pub use factor_configuration::FactorConfigurationBinding;
pub use key_file::{
    encode_key_file, init_versioned_key_file, list_protector_summaries, load_key_file,
    parse_key_file_json, password_wrapper_from_manifest, sync_dir, unlock_key_file_with_password,
    write_key_file, write_synced, KeyFileContents,
};
pub use legacy::{
    looks_like_legacy_password_wrapper, parse_legacy_password_wrapper,
    unlock_legacy_password_wrapper,
};
pub use limits::*;
pub use native_factor_configuration::{
    assert_native_factor_configuration, prepare_native_factor_configuration,
};
pub use ops::{
    ensure_versioned_manifest, protect_add_age_recipient, protect_add_recovery, protect_list,
    protect_remove, protect_rewrap_password, protect_test_password, protect_test_recovery,
};
pub use parse::parse_root_protection_manifest;
pub use recovery::{
    fingerprint_recovery_key, generate_recovery_key, unwrap_vrk_with_recovery_key,
    wrap_vrk_with_recovery_key,
};
pub use rotation::{
    prepare_root_rotation, CapsuleSealer, PreparedRotation, ReissuedRecovery, RotationEdit,
};
pub use types::{
    AuthenticatedLegacyGates, ProofStatus, ProtectionPurpose, ProtectionRecord, ProtectorSummary,
    RootProtectionManifest, VerificationEvidence,
};

#[cfg(test)]
mod native_factor_producer_tests;

#[cfg(unix)]
#[path = "../unix_private_files.rs"]
pub mod unix_private_files;

#[cfg(windows)]
#[path = "../windows_private_files.rs"]
pub mod windows_private_files;

#[cfg(any(unix, windows))]
pub use new_password_root::init_private_versioned_key_file;

/// Shared native physical lease name protocol; metadata grants no owner authority.
pub mod physical_writer_lease;

#[cfg(any(unix, windows))]
pub mod node_data_state;
