//! Git-native hierarchical sealed secret store (`pass` parity).
//!
//! Ciphertext files live under a store root (default `~/.password-store`).
//! Agents never receive plaintext through this crate's public surface used by
//! Host invoke paths — reveal is a human CLI concern.

mod age_fmt;
mod entry;
mod envelope;
mod generate;
mod git;
mod gpg;
mod otp;
mod path;
mod recipients;
mod root;
mod store;
mod tomb_registry;
mod update;

pub use age_fmt::{decrypt_age_file, encrypt_age_file, read_age_recipients};
pub use entry::Entry;
pub use envelope::{open_osseal, seal_osseal, OSSEAL_MAGIC};
pub use generate::generate_password;
pub use git::{auto_commit, ensure_git_repo, git_passthrough};
pub use gpg::{decrypt_gpg_file, encrypt_gpg_file, read_gpg_id};
pub use otp::{
    find_otpauth_in_trailer, parse_otpauth, sync_trailer_otp, totp_code, validate_otpauth, OtpError,
    OtpUri,
};
pub use path::{logical_to_relative, relative_to_logical};
pub use recipients::Recipients;
pub use root::{resolve_store_dir, StoreError, StoreRoot};
pub use store::{init_store, init_store_key, list_names, unlock_store_key, FormatHint};
pub use tomb_registry::{
    default_tombs_config_path, load_tomb_registry, resolve_tomb_paths, save_tomb_registry,
    TombBackend, TombEntry, TombRegistry, TombRegistryError,
};
pub use update::{apply_secret_update, UpdateMode, UpdateOptions};

pub use opensesame_human_vault::{ItemDataKey, VaultRootKey};
