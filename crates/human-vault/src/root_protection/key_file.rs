//! Versioned and legacy `.opensesame-key` load/store (NATIVE / KP-03).

use std::fs;
use std::path::Path;

use serde_json::Value;

use crate::password_wrap::{unwrap_vrk_with_password, wrap_vrk_with_password, PasswordWrapper};
use crate::{ItemDataKey, VaultRootKey};

use super::auth::{seal_manifest_auth, verify_manifest_auth};
use super::error::ProtectionError;
use super::legacy::{
    looks_like_legacy_password_wrapper, parse_legacy_password_wrapper,
    unlock_legacy_password_wrapper,
};
use super::limits::{
    KEY_FILE_NAME, MANIFEST_SCHEMA_VERSION, MAX_MANIFEST_ENCODED_BYTES, MAX_PROTECTION_RECORDS,
    MAX_RECORD_ENCODED_BYTES,
};
use super::types::{
    ProofStatus, ProtectionPurpose, ProtectionRecord, ProtectorSummary, RootProtectionManifest,
};

/// Contents of `.opensesame-key`.
#[derive(Debug, Clone)]
pub enum KeyFileContents {
    Legacy(PasswordWrapper),
    Manifest(RootProtectionManifest),
}

/// Load `.opensesame-key` under `root`.
///
/// # Errors
///
/// Returns typed parse errors for legacy vs versioned shapes.
pub fn load_key_file(root: &Path) -> Result<KeyFileContents, ProtectionError> {
    let path = root.join(KEY_FILE_NAME);
    if !path.exists() {
        return Err(ProtectionError::Io(format!("missing {}", path.display())));
    }
    let json = fs::read_to_string(&path)?;
    if json.len() > MAX_MANIFEST_ENCODED_BYTES {
        return Err(ProtectionError::OversizedManifest);
    }
    parse_key_file_json(&json)
}

/// Parse key-file JSON without touching the filesystem.
///
/// # Errors
///
/// Returns typed parse errors for legacy vs versioned shapes.
pub fn parse_key_file_json(json: &str) -> Result<KeyFileContents, ProtectionError> {
    let value: Value = serde_json::from_str(json)
        .map_err(|e| ProtectionError::MalformedEncoding(format!("json: {e}")))?;
    if looks_like_legacy_password_wrapper(&value) {
        return Ok(KeyFileContents::Legacy(parse_legacy_password_wrapper(
            json,
        )?));
    }
    let manifest: RootProtectionManifest = serde_json::from_value(value)
        .map_err(|e| ProtectionError::MalformedEncoding(format!("manifest: {e}")))?;
    validate_manifest_bounds(&manifest)?;
    Ok(KeyFileContents::Manifest(manifest))
}

/// Serialize key-file contents exactly as [`write_key_file`] would.
///
/// # Errors
///
/// Returns bounds or encoding failures.
pub fn encode_key_file(contents: &KeyFileContents) -> Result<String, ProtectionError> {
    let json = match contents {
        KeyFileContents::Legacy(wrapper) => serde_json::to_string_pretty(wrapper)
            .map_err(|e| ProtectionError::MalformedEncoding(e.to_string()))?,
        KeyFileContents::Manifest(manifest) => {
            validate_manifest_bounds(manifest)?;
            serde_json::to_string_pretty(manifest)
                .map_err(|e| ProtectionError::MalformedEncoding(e.to_string()))?
        }
    };
    if json.len() > MAX_MANIFEST_ENCODED_BYTES {
        return Err(ProtectionError::OversizedManifest);
    }
    Ok(json)
}

/// Persist key-file contents under `root`, atomically: a sibling temp file is
/// written and fsynced, then renamed over `.opensesame-key`, so a crash leaves
/// either the old key file or the new one — never a truncated wrap.
///
/// # Errors
///
/// Returns IO or encoding failures.
pub fn write_key_file(root: &Path, contents: &KeyFileContents) -> Result<(), ProtectionError> {
    let json = encode_key_file(contents)?;
    let tmp = root.join(format!(
        "{KEY_FILE_NAME}.{}.tmp",
        uuid::Uuid::new_v4().simple()
    ));
    let written = write_synced(&tmp, json.as_bytes())
        .and_then(|()| fs::rename(&tmp, root.join(KEY_FILE_NAME)));
    if let Err(error) = written {
        let _ = fs::remove_file(&tmp);
        return Err(error.into());
    }
    sync_dir(root);
    Ok(())
}

/// Create `path` owner-only, write `bytes`, and fsync before returning.
///
/// # Errors
///
/// Returns the underlying IO failure.
pub fn write_synced(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    let mut file = options.open(path)?;
    file.write_all(bytes)?;
    file.sync_all()
}

/// Best-effort directory fsync so a completed rename survives power loss.
pub fn sync_dir(dir: &Path) {
    #[cfg(unix)]
    if let Ok(handle) = fs::File::open(dir) {
        let _ = handle.sync_all();
    }
    #[cfg(not(unix))]
    let _ = dir;
}

/// Create a versioned key file wrapping a fresh VRK under `password`.
///
/// Returns the content key (`ItemDataKey(vrk.0)` — same direct-root mapping as
/// historical `init_store_key`).
///
/// # Errors
///
/// Returns wrap or IO failures.
pub fn init_versioned_key_file(
    root: &Path,
    password: &[u8],
) -> Result<(ItemDataKey, RootProtectionManifest), ProtectionError> {
    let vrk = VaultRootKey::generate();
    let wrapper = wrap_vrk_with_password(password, &vrk)?;
    let vault_id = uuid::Uuid::new_v4().to_string();
    let root_key_id = uuid::Uuid::new_v4().to_string();
    let protector_id = uuid::Uuid::new_v4().to_string();
    let mut manifest = RootProtectionManifest {
        schema_version: MANIFEST_SCHEMA_VERSION,
        vault_id,
        root_key_id,
        root_epoch: 1,
        revision: 1,
        purpose: ProtectionPurpose::HumanVaultRoot,
        records: vec![ProtectionRecord::Password {
            protector_id: protector_id.clone(),
            legacy: true,
            wrapper,
            proof_status: ProofStatus::Verified,
            last_evidence: None,
        }],
        preferred_protector_id: Some(protector_id),
        legacy_gates: None,
        auth_b64: None,
    };
    seal_manifest_auth(&vrk, &mut manifest)?;
    write_key_file(root, &KeyFileContents::Manifest(manifest.clone()))?;
    Ok((ItemDataKey(vrk.0), manifest))
}

/// Unlock either legacy or versioned key file with a password.
///
/// Preserves `ItemDataKey(vrk.0)` content-key mapping.
///
/// # Errors
///
/// Returns typed legacy / manifest / crypto failures.
pub fn unlock_key_file_with_password(
    root: &Path,
    password: &[u8],
) -> Result<(ItemDataKey, KeyFileContents, VaultRootKey), ProtectionError> {
    let contents = load_key_file(root)?;
    let vrk = match &contents {
        KeyFileContents::Legacy(wrapper) => unlock_legacy_password_wrapper(password, wrapper)?,
        KeyFileContents::Manifest(manifest) => {
            if manifest.schema_version != MANIFEST_SCHEMA_VERSION {
                return Err(ProtectionError::UnsupportedVersion(manifest.schema_version));
            }
            let wrapper = password_wrapper_from_manifest(manifest)?;
            let vrk = unwrap_vrk_with_password(password, wrapper)?;
            verify_manifest_auth(&vrk, manifest)?;
            vrk
        }
    };
    Ok((ItemDataKey(vrk.0), contents, vrk))
}

/// Summaries for `pass protect list` (no secrets).
#[must_use]
pub fn list_protector_summaries(contents: &KeyFileContents) -> Vec<ProtectorSummary> {
    match contents {
        KeyFileContents::Legacy(_) => vec![ProtectorSummary {
            protector_id: "legacy-password".into(),
            kind: "password".into(),
            proof_status: ProofStatus::Verified,
        }],
        KeyFileContents::Manifest(m) => m
            .records
            .iter()
            .map(|r| ProtectorSummary {
                protector_id: r.protector_id().to_string(),
                kind: r.kind_name().to_string(),
                proof_status: r.proof_status(),
            })
            .collect(),
    }
}

/// Extract the password wrapper from a versioned manifest.
///
/// # Errors
///
/// Returns `ProtectorNotFound` when no password record exists.
pub fn password_wrapper_from_manifest(
    manifest: &RootProtectionManifest,
) -> Result<&PasswordWrapper, ProtectionError> {
    for record in &manifest.records {
        if let ProtectionRecord::Password { wrapper, .. } = record {
            return Ok(wrapper);
        }
    }
    Err(ProtectionError::ProtectorNotFound)
}

fn validate_manifest_bounds(manifest: &RootProtectionManifest) -> Result<(), ProtectionError> {
    if manifest.schema_version != MANIFEST_SCHEMA_VERSION {
        return Err(ProtectionError::UnsupportedVersion(manifest.schema_version));
    }
    if manifest.records.len() > MAX_PROTECTION_RECORDS {
        return Err(ProtectionError::TooManyRecords);
    }
    let mut seen = std::collections::BTreeSet::new();
    for record in &manifest.records {
        let id = record.protector_id();
        if !seen.insert(id.to_string()) {
            return Err(ProtectionError::DuplicateProtectorId);
        }
        let encoded = serde_json::to_vec(record)
            .map_err(|e| ProtectionError::MalformedEncoding(e.to_string()))?;
        if encoded.len() > MAX_RECORD_ENCODED_BYTES {
            return Err(ProtectionError::OversizedRecord);
        }
    }
    Ok(())
}
