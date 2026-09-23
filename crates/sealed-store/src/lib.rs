//! Git-native hierarchical sealed secret store (`pass` parity).
//!
//! Ciphertext files live under a store root (default `~/.password-store`).
//! Agents never receive plaintext through this crate's public surface used by
//! Host invoke paths — reveal is a human CLI concern.

mod age_fmt;
mod attachment;
mod entry;
mod envelope;
mod generate;
mod git;
mod gpg;
mod history;
mod manifest;
mod otp {
    #[cfg(test)]
    pub use opensesame_authenticator_core::parse_otpauth;
    pub use opensesame_authenticator_core::{find_otpauth_in_trailer, sync_trailer_otp, OtpUri};
}
mod object_store;
mod path;
mod recipients;
mod root;
mod root_protection;
mod rotation;
mod rotation_walk;
mod piv_age;
mod sops_interop;
mod store;
mod store_lock;
mod tomb_registry;
mod update;

pub use age_fmt::{decrypt_age_file, encrypt_age_file, read_age_recipients};
pub use attachment::{
    sanitize_filename, AttachMeta, AttachmentManifest, AttachmentSummary, ChunkRef, GcOutcome,
    ATTACHMENT_REVISION_FILE, ATTACH_EXT, CHUNK_EXT, CHUNK_PLAINTEXT_BYTES, GC_GRACE_SECONDS,
    MAX_ATTACHMENT_BYTES,
};
pub use entry::Entry;
pub use envelope::{open_osseal, seal_osseal, OpenedOsseal, OSSEAL_MAGIC};
pub use generate::generate_password;
pub use git::{
    auto_commit, auto_push_enabled, ensure_git_repo, git_passthrough, push_backup, remote_url,
    set_auto_push, set_remote, GIT_TOKEN_ENV,
};
pub use gpg::{decrypt_gpg_file, encrypt_gpg_file, read_gpg_id};
// —— entry history / restore (pass history, pass restore) ————————————————
pub use history::{entry_history, restore_entry, HistoryEntry};
// —— end entry history / restore ——————————————————————————————————————————
pub use manifest::{parse_manifest, seal_manifest, ManifestEntry, SealOutcome};
pub use object_store::{assert_confined_rel, FsObjectStore, ObjectStore};
pub use opensesame_authenticator_core::{
    find_otpauth_in_trailer, hotp_code, parse_otpauth, sync_trailer_otp, totp_code,
    validate_otpauth, OtpAlgorithm, OtpError, OtpKind, OtpUri,
};
pub use path::{logical_to_relative, relative_to_logical};
pub use recipients::Recipients;
pub use root::{resolve_store_dir, StoreError, StoreRoot};
pub use store::{init_store, init_store_key, list_names, unlock_store_key, FormatHint};
pub use root_protection::{
    protect_add_store_age_recipient, protect_add_store_recovery, protect_list_store,
    protect_remove_store, protect_rewrap_store_password, protect_test_store_password,
    protect_test_store_recovery,
};
pub use rotation::{rotate_store_root, RotationOutcome, ROTATION_STAGING_DIR};
pub use piv_age::{discover_piv_age, refuse_destructive_ykman, PivAgeDiscovery, PivAgeError, PivAgeRuntime};
pub use sops_interop::{resolve_sops_bin, sops_decrypt, sops_encrypt, SopsError, SopsFormat};
pub use opensesame_human_vault::root_protection::{
    ProofStatus, ProtectionError, ProtectorSummary, ReissuedRecovery, RootProtectionManifest,
    RotationEdit, KEY_FILE_NAME, MANIFEST_SCHEMA_VERSION,
};
pub use tomb_registry::{
    default_tombs_config_path, ensure_personal_project_tomb, load_tomb_registry,
    personal_project_tomb_name, resolve_project_tomb_name, resolve_tomb_paths, save_tomb_registry,
    TombBackend, TombEntry, TombRegistry, TombRegistryError, PERSONAL_PROJECT_TOMB_NAME,
};
pub use update::{
    apply_secret_update, rotate_secret_entry, RotationChangelogEvent, SecretRotation, UpdateMode,
    UpdateOptions, CHANGELOG_SECRET_VALUE_CHANGED,
};

pub use opensesame_human_vault::{ItemDataKey, VaultRootKey};
