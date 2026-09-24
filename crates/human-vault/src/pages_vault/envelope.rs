//! The two portable envelopes (vault-format-v1 §7): the sealed export
//! (`opensesame-vault-export`) and the offline backup
//! (`opensesame-offline-backup`). Each is parsed and every §7 rule applied
//! before a key is involved.

use serde_json::Value;

use super::{
    error::{Result, VaultFileError},
    header::{SealedBlob, VaultHeader},
};

pub const VAULT_EXPORT_FORMAT: &str = "opensesame-vault-export";
pub const OFFLINE_BACKUP_FORMAT: &str = "opensesame-offline-backup";
/// §7.2: a backup larger than this is refused unread.
pub const MAX_OFFLINE_BACKUP_BYTES: usize = 64 * 1024 * 1024;
const MAX_SYNC_BLOBS: usize = 4096;
/// §7.2: text that marks plaintext or a deployment-seal wrap in a backup.
const FORBIDDEN_SUBSTRINGS: [&str; 6] = [
    "\"plaintext\"",
    "\"password\":",
    "\"secret\":",
    "\"token\":",
    "OPENSESAME_CONNECTION_KEY",
    "deployment_seal",
];

const NOT_A_VAULT_FILE: VaultFileError = VaultFileError::Rejected("not a vault file");
const NOT_A_BACKUP: VaultFileError = VaultFileError::Rejected("not an OpenSesame offline backup");
const MISSING_VAULT: VaultFileError =
    VaultFileError::Rejected("the backup is missing sealed vault ciphertext");
const MALFORMED_SYNC_BLOB: VaultFileError =
    VaultFileError::Rejected("the backup has a malformed sync blob");

/// Which envelope a vault file is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VaultFileFormat {
    Export,
    OfflineBackup,
}

impl VaultFileFormat {
    /// The envelope's `format` string.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Export => VAULT_EXPORT_FORMAT,
            Self::OfflineBackup => OFFLINE_BACKUP_FORMAT,
        }
    }
}

/// A vault file's sealed parts, before any key is involved.
pub struct SealedVaultFile {
    pub format: VaultFileFormat,
    /// The tomb the body's seal names (§6, §7).
    pub tomb: String,
    pub header: VaultHeader,
    pub(super) body: SealedBlob,
    /// Opaque sync ciphertext a backup carries; never opened (§7.2).
    pub sync_blobs: usize,
}

/// Parse either envelope and apply §7.
///
/// # Errors
///
/// `Rejected` for anything §7 refuses (including text that is not a vault
/// file), `Corrupt` for a header or seal that cannot be read.
pub fn read_vault_file(text: &str) -> Result<SealedVaultFile> {
    let parsed: Value = serde_json::from_str(text).map_err(|_| NOT_A_VAULT_FILE)?;
    match parsed.get("format").and_then(Value::as_str) {
        Some(OFFLINE_BACKUP_FORMAT) => read_backup(text, &parsed),
        Some(VAULT_EXPORT_FORMAT) => read_export(&parsed),
        _ => Err(NOT_A_VAULT_FILE),
    }
}

/// §7.1. The tomb must be named: a standalone reader has no importing vault
/// whose tomb it could fall back to.
fn read_export(parsed: &Value) -> Result<SealedVaultFile> {
    let tomb = parsed
        .get("tomb")
        .and_then(Value::as_str)
        .filter(|tomb| !tomb.is_empty())
        .ok_or(VaultFileError::Rejected("the export names no tomb"))?;
    let header = parsed
        .get("header")
        .filter(|header| header.is_object())
        .ok_or(NOT_A_VAULT_FILE)?;
    let body = parsed
        .get("body")
        .filter(|body| body.is_object())
        .ok_or(NOT_A_VAULT_FILE)?;
    // Only the password wrap is portable (§5), so it is checked before the
    // header is read at all.
    let wrapped = ["wrap", "kdf"]
        .iter()
        .all(|field| header.get(field).is_some_and(|value| !value.is_null()));
    if !wrapped {
        return Err(VaultFileError::Rejected(
            "the export has no master-password wrap",
        ));
    }
    let header = VaultHeader::parse(header)?;
    Ok(SealedVaultFile {
        format: VaultFileFormat::Export,
        tomb: tomb.to_owned(),
        header,
        body: SealedBlob::parse(body)?,
        sync_blobs: 0,
    })
}

/// §7.2, in the writer's order: size, plaintext markers, format and version,
/// the deployment seal, the vault part, the sync blobs.
fn read_backup(text: &str, parsed: &Value) -> Result<SealedVaultFile> {
    if text.len() > MAX_OFFLINE_BACKUP_BYTES {
        return Err(VaultFileError::Rejected(
            "the offline backup is larger than 64 MiB",
        ));
    }
    if FORBIDDEN_SUBSTRINGS
        .iter()
        .any(|needle| text.contains(needle))
    {
        return Err(VaultFileError::Rejected(
            "the backup carries plaintext or deployment-seal fields",
        ));
    }
    if parsed.get("v").and_then(Value::as_f64) != Some(1.0) {
        return Err(NOT_A_BACKUP);
    }
    if parsed.get("deploymentSealUsed") != Some(&Value::Bool(false)) {
        return Err(VaultFileError::Rejected(
            "the backup claims a deployment seal wrap",
        ));
    }
    let (header, body) = read_vault_part(parsed.get("vault"))?;
    let sync_blobs = count_sync_blobs(parsed.get("syncBlobs"))?;
    // `projectId ?? "personal"`: the writer sets it to the tomb unless the
    // tomb is the personal one (`vault-backup-sync.ts`).
    let tomb = parsed
        .get("projectId")
        .and_then(Value::as_str)
        .unwrap_or("personal");
    Ok(SealedVaultFile {
        format: VaultFileFormat::OfflineBackup,
        tomb: tomb.to_owned(),
        header: VaultHeader::parse(header)?,
        body: SealedBlob::parse(body)?,
        sync_blobs,
    })
}

fn read_vault_part(vault: Option<&Value>) -> Result<(&Value, &Value)> {
    let vault = vault
        .filter(|vault| vault.is_object())
        .ok_or(MISSING_VAULT)?;
    let header = vault
        .get("header")
        .filter(|header| header.is_object())
        .ok_or(MISSING_VAULT)?;
    let body = vault
        .get("body")
        .filter(|body| {
            body.get("ivB64").is_some_and(Value::is_string)
                && body.get("ctB64").is_some_and(Value::is_string)
        })
        .ok_or(MISSING_VAULT)?;
    Ok((header, body))
}

/// Sync blobs are opaque ciphertext: counted and bounded, never opened.
fn count_sync_blobs(value: Option<&Value>) -> Result<usize> {
    let Some(blobs) = value.and_then(Value::as_array) else {
        return Ok(0);
    };
    if blobs.len() > MAX_SYNC_BLOBS {
        return Err(VaultFileError::Rejected(
            "the backup has too many sync blobs",
        ));
    }
    let mut total = 0usize;
    for blob in blobs {
        let ciphertext = blob
            .get("ciphertextB64")
            .and_then(Value::as_str)
            .filter(|ciphertext| !ciphertext.is_empty());
        let well_formed = blob.get("id").is_some_and(Value::is_string)
            && blob.get("epoch").is_some_and(Value::is_number)
            && ciphertext.is_some();
        let Some(ciphertext) = ciphertext.filter(|_| well_formed) else {
            return Err(MALFORMED_SYNC_BLOB);
        };
        total = total.saturating_add(ciphertext.len());
        if total > MAX_OFFLINE_BACKUP_BYTES {
            return Err(VaultFileError::Rejected(
                "the backup's sync ciphertext is larger than 64 MiB",
            ));
        }
    }
    Ok(blobs.len())
}
