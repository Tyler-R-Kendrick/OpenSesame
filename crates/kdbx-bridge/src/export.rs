//! Sealed store → KDBX.

use std::collections::BTreeMap;
use std::io::Cursor;

use keepass::config::{
    CompressionConfig, DatabaseConfig, DatabaseVersion, InnerCipherConfig, KdfConfig,
    OuterCipherConfig,
};
use keepass::db::{Database, GroupId};
use keepass::DatabaseKey;
use opensesame_sealed_store::{ItemDataKey, StoreRoot};
use zeroize::Zeroize;

use crate::map;
use crate::{KdbxError, EXPORT_KDBX_MINOR_VERSION};

/// Name given to the exported database's root group.
pub const ROOT_GROUP_NAME: &str = "OpenSesame";

/// Outer cipher for an exported database.
///
/// Deliberately only the two the `KDBX 4` specification and every mainstream
/// client agree on. `Twofish` is reachable in the `keepass` crate and is not
/// offered.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum ExportCipher {
    /// `AES-256` in `CBC` mode (the `KeePass` default).
    #[default]
    Aes256,
    /// `ChaCha20`.
    ChaCha20,
}

/// `Argon2id` work factors for an exported database.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Argon2Params {
    /// Passes over memory.
    pub iterations: u64,
    /// Memory cost in KiB (KDBX stores it in bytes; the conversion is here).
    pub memory_kib: u64,
    /// Lanes.
    pub parallelism: u32,
}

impl Default for Argon2Params {
    /// `KeePassXC`'s own defaults: 64 MiB, 2 passes, 4 lanes.
    fn default() -> Self {
        Self {
            iterations: 2,
            memory_kib: 64 * 1024,
            parallelism: 4,
        }
    }
}

impl Argon2Params {
    /// Deliberately weak parameters for tests that round-trip many databases.
    /// Never use for anything a user keeps.
    #[must_use]
    pub fn weak_for_tests() -> Self {
        Self {
            iterations: 1,
            memory_kib: 64,
            parallelism: 1,
        }
    }
}

/// Options for [`export_kdbx`].
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ExportOptions {
    /// Outer cipher.
    pub cipher: ExportCipher,
    /// Argon2id work factors.
    pub argon2: Argon2Params,
    /// Optional keyfile, combined with the password.
    pub keyfile: Option<Vec<u8>>,
}

impl ExportOptions {
    /// Use `ChaCha20` instead of `AES-256`.
    #[must_use]
    pub fn with_cipher(mut self, cipher: ExportCipher) -> Self {
        self.cipher = cipher;
        self
    }

    /// Add a keyfile to the composite key.
    #[must_use]
    pub fn with_keyfile(mut self, keyfile: Vec<u8>) -> Self {
        self.keyfile = Some(keyfile);
        self
    }

    /// Use [`Argon2Params::weak_for_tests`].
    #[must_use]
    pub fn with_argon2(mut self, argon2: Argon2Params) -> Self {
        self.argon2 = argon2;
        self
    }
}

/// Write the store (or the subtree under `prefix`) as a `KDBX 4` database.
///
/// Output is constrained on purpose — the `keepass` crate's KDBX4 writer is
/// experimental, so this emits only the configuration mainstream clients read
/// without argument: `KDBX 4.1`, `AES-256` or `ChaCha20` outer, `ChaCha20`
/// inner, `GZip`, `Argon2id`. `fixtures/kdbx/roundtrip.kdbx` is the
/// cross-implementation guard on that claim.
///
/// The returned bytes are plaintext-equivalent: every store secret under
/// `prefix` is inside them, protected only by `password`/`opts.keyfile`. This
/// is a human-plane operation (constitution C2) and callers must gate it
/// behind the same ceremony as `pass show --reveal`.
///
/// # Errors
///
/// Returns an error when credentials are absent, store traversal or decryption
/// fails, the constrained writer configuration is unavailable, keyfile parsing
/// fails, or the encrypted database cannot be written.
pub fn export_kdbx(
    root: &StoreRoot,
    key: &ItemDataKey,
    prefix: Option<&str>,
    password: &str,
    opts: ExportOptions,
) -> Result<Vec<u8>, KdbxError> {
    let ExportOptions {
        cipher,
        argon2,
        keyfile,
    } = opts;
    if password.is_empty() && keyfile.is_none() {
        return Err(KdbxError::MissingCredentials);
    }

    let mut db = Database::with_config(database_config(cipher, &argon2)?);
    let root_id = db.root().id();
    db.root_mut().name = ROOT_GROUP_NAME.to_string();

    let names = root.ls(prefix.unwrap_or(""))?;
    let mut groups: BTreeMap<Vec<String>, GroupId> = BTreeMap::new();
    groups.insert(Vec::new(), root_id);

    for name in &names {
        let entry = root.show(name, key)?;
        let unmapped = map::unmap_entry(name, &entry);

        let mut parent = root_id;
        let mut walked: Vec<String> = Vec::new();
        for segment in &unmapped.group_path {
            walked.push(segment.clone());
            if let Some(id) = groups.get(&walked) {
                parent = *id;
                continue;
            }
            let mut parent_group = db
                .group_mut(parent)
                .ok_or_else(|| KdbxError::Write("lost a group while building the tree".into()))?;
            let mut child = parent_group.add_group();
            child.name.clone_from(segment);
            parent = child.id();
            groups.insert(walked.clone(), parent);
        }

        let mut parent_group = db
            .group_mut(parent)
            .ok_or_else(|| KdbxError::Write("lost a group while building the tree".into()))?;
        let mut kdbx_entry = parent_group.add_entry();
        for field in &unmapped.fields {
            if field.protected {
                kdbx_entry.set_protected(field.key.as_str(), field.value.as_str());
            } else {
                kdbx_entry.set_unprotected(field.key.as_str(), field.value.as_str());
            }
        }
    }

    let mut db_key = DatabaseKey::new().with_password(password);
    if let Some(keyfile) = &keyfile {
        db_key = db_key
            .with_keyfile(&mut Cursor::new(keyfile))
            .map_err(|e| KdbxError::Write(format!("keyfile: {e}")))?;
    }

    let mut out = Vec::new();
    db.save(&mut out, db_key)
        .map_err(|e| KdbxError::Write(e.to_string()))?;
    // The in-memory database still holds every secret; drop it explicitly so
    // the plaintext lives no longer than it must.
    drop(db);
    Ok(out)
}

/// Build the constrained writer configuration.
fn database_config(
    cipher: ExportCipher,
    argon2: &Argon2Params,
) -> Result<DatabaseConfig, KdbxError> {
    // `argon2::Version` is not re-exported by `keepass`, so the version is
    // taken from the library's own default rather than by adding a direct
    // `rust-argon2` dependency just to name one enum variant.
    let (KdfConfig::Argon2 { version, .. } | KdfConfig::Argon2id { version, .. }) =
        DatabaseConfig::default().kdf_config
    else {
        return Err(KdbxError::Write(
            "the keepass crate no longer defaults to an Argon2 KDF".to_string(),
        ));
    };
    let argon2_version = version;

    // `DatabaseConfig` is `#[non_exhaustive]`, so it can only be built by
    // mutating a default — struct and functional-update syntax are both
    // unavailable outside the `keepass` crate.
    #[allow(clippy::field_reassign_with_default)]
    let mut config = DatabaseConfig::default();
    config.version = DatabaseVersion::KDB4(EXPORT_KDBX_MINOR_VERSION);
    config.outer_cipher_config = match cipher {
        ExportCipher::Aes256 => OuterCipherConfig::AES256,
        ExportCipher::ChaCha20 => OuterCipherConfig::ChaCha20,
    };
    config.compression_config = CompressionConfig::GZip;
    config.inner_cipher_config = InnerCipherConfig::ChaCha20;
    config.kdf_config = KdfConfig::Argon2id {
        iterations: argon2.iterations.max(1),
        memory: argon2.memory_kib.max(8).saturating_mul(1024),
        parallelism: argon2.parallelism.max(1),
        version: argon2_version,
    };
    Ok(config)
}

/// Zeroize a plaintext buffer the caller no longer needs.
///
/// `export_kdbx` returns ciphertext, so this is for callers that build
/// plaintext intermediates around it.
pub fn zeroize_buffer(buffer: &mut Vec<u8>) {
    buffer.zeroize();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_are_the_constrained_profile() {
        let opts = ExportOptions::default();
        let config = database_config(opts.cipher, &opts.argon2).expect("config");
        assert_eq!(config.version, DatabaseVersion::KDB4(1));
        assert_eq!(config.outer_cipher_config, OuterCipherConfig::AES256);
        assert_eq!(config.compression_config, CompressionConfig::GZip);
        assert_eq!(config.inner_cipher_config, InnerCipherConfig::ChaCha20);
        match config.kdf_config {
            KdfConfig::Argon2id {
                iterations,
                memory,
                parallelism,
                ..
            } => {
                assert_eq!(iterations, 2);
                assert_eq!(memory, 64 * 1024 * 1024);
                assert_eq!(parallelism, 4);
            }
            other => panic!("expected Argon2id, got {other:?}"),
        }
    }

    #[test]
    fn chacha20_is_selectable() {
        let opts = ExportOptions::default().with_cipher(ExportCipher::ChaCha20);
        let config = database_config(opts.cipher, &opts.argon2).expect("config");
        assert_eq!(config.outer_cipher_config, OuterCipherConfig::ChaCha20);
    }

    #[test]
    fn degenerate_argon2_parameters_are_floored() {
        let opts = ExportOptions::default().with_argon2(Argon2Params {
            iterations: 0,
            memory_kib: 0,
            parallelism: 0,
        });
        match database_config(opts.cipher, &opts.argon2)
            .expect("config")
            .kdf_config
        {
            KdfConfig::Argon2id {
                iterations,
                memory,
                parallelism,
                ..
            } => {
                assert_eq!(iterations, 1);
                assert_eq!(memory, 8 * 1024);
                assert_eq!(parallelism, 1);
            }
            other => panic!("expected Argon2id, got {other:?}"),
        }
    }

    #[test]
    fn zeroize_buffer_clears_plaintext() {
        let mut buffer = b"super-secret".to_vec();
        zeroize_buffer(&mut buffer);
        assert!(buffer.is_empty());
    }
}
