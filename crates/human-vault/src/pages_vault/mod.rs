//! A reader for the vault the Pages PWA writes — vault format v1
//! (`docs/architecture/vault-format-v1.md`), checked against the golden
//! vectors in `spec/conformance/vault-vectors.json` (ADR 0139) that the
//! TypeScript reader (`packages/vault-core`) opens too.
//!
//! This is a different format from the rest of this crate: PBKDF2 and
//! AES-256-GCM rather than Argon2id and XChaCha20-Poly1305 (ADR 0133). The
//! reader does what §9 asks of every conforming reader:
//!
//! 1. parse the envelope (§7) and refuse anything §7 rejects;
//! 2. validate the header KDF (§3) before deriving;
//! 3. derive with NFKC normalisation (§2) and unwrap VK — a tag failure is
//!    the wrong password;
//! 4. open the body bound to the tomb, falling back to unbound, and report
//!    which;
//! 5. compare the sealed `rev` with `header.bodyRev` and report a rollback;
//! 6. write nothing: VK, the KEKs and the decrypted body are zeroized, and
//!    nothing returned carries a field value.
//!
//! The PIN (§5, PBKDF2) and passkey PRF (§5, HKDF-SHA-256, as
//! `kek_from_webauthn_prf`) unwraps are here too; both belong to the device
//! that enrolled them, so only the password opens a vault file elsewhere.

mod b64;
mod body;
mod envelope;
mod error;
mod header;
mod keys;
mod listing;
mod pin;

pub use body::{open_body, vault_seal_binding, OpenedBody};
pub use envelope::{
    read_vault_file, SealedVaultFile, VaultFileFormat, MAX_OFFLINE_BACKUP_BYTES,
    OFFLINE_BACKUP_FORMAT, VAULT_EXPORT_FORMAT,
};
pub use error::{Result, VaultFileError};
pub use header::{PasskeyRecord, VaultHeader, MAX_PBKDF2_ITERATIONS, MIN_PBKDF2_ITERATIONS};
pub use keys::{unwrap_with_password, unwrap_with_pin, unwrap_with_prf, VaultKey};
pub use listing::{
    legacy_extension, path_segment, summarize, ExtensionOf, OpenedVaultFile, VaultFileEntry,
};

/// Open a vault file with its master password and list it, resolving item
/// extensions with `extension_of`.
///
/// # Errors
///
/// `Rejected` for a file §7 refuses, `Corrupt` for a damaged or edited one,
/// `WrongPassword` for the wrong password.
pub fn open_vault_file_with(
    text: &str,
    password: &str,
    extension_of: ExtensionOf<'_>,
) -> Result<OpenedVaultFile> {
    let file = read_vault_file(text)?;
    let key = unwrap_with_password(&file.header, password)?;
    let body = open_body(&file, &key)?;
    Ok(summarize(&file, &body, extension_of))
}

/// [`open_vault_file_with`] with the legacy kinds' built-in extensions.
///
/// # Errors
///
/// As [`open_vault_file_with`].
pub fn open_vault_file(text: &str, password: &str) -> Result<OpenedVaultFile> {
    open_vault_file_with(text, password, &legacy_extension)
}
