//! Bounded defaults for native root-protection manifests (C04).

pub const MAX_PROTECTION_RECORDS: usize = 64;
pub const MAX_RECORD_ENCODED_BYTES: usize = 64 * 1024;
pub const MAX_MANIFEST_ENCODED_BYTES: usize = 1024 * 1024;
pub const ROOT_KEY_BYTES: usize = 32;
pub const WRAPPING_SECRET_BYTES: usize = 32;
pub const MANIFEST_SCHEMA_VERSION: u32 = 1;
pub const DOMAIN_MANIFEST: &[u8] = b"opensesame/vault/root-manifest/v1";
pub const DOMAIN_CAPSULE: &[u8] = b"opensesame/vault/root-capsule/v1";
pub const DOMAIN_MANIFEST_MAC: &[u8] = b"opensesame/vault/root-manifest-mac/v1";
pub const DOMAIN_CLOUD_WRAP: &[u8] = b"opensesame/vault/cloud-wrapping-secret/v1";
pub const DOMAIN_RECOVERY_WRAP: &[u8] = b"opensesame/vault/recovery-wrap/v1";
pub const KEY_FILE_NAME: &str = ".opensesame-key";
