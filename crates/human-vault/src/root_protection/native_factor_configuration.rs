//! Native public configuration metadata. Hashing never authenticates an owner or factor.
use std::io::{self, Write};

use serde_json::Value;
use sha2::{Digest, Sha256};

use super::{
    canonicalize_to_bytes, key_file::validate_manifest_bounds, FactorConfigurationBinding,
    ProtectionError, RootProtectionManifest, MAX_MANIFEST_ENCODED_BYTES,
};

const DOMAIN: &[u8] = b"opensesame/native/factor-configuration/v1";

struct BoundedJson {
    bytes: Vec<u8>,
    exceeded: bool,
}

impl Write for BoundedJson {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        if bytes.len() > MAX_MANIFEST_ENCODED_BYTES.saturating_sub(self.bytes.len()) {
            self.exceeded = true;
            return Err(io::Error::other(
                "native configuration exceeds its size bound",
            ));
        }
        self.bytes.extend_from_slice(bytes);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

/// Compute native-only public binding metadata from the actual known configuration.
/// The digest includes identities, epoch/revision, record/wrapper/evidence metadata,
/// selected preference, purpose and gate declarations. MAC and binding are excluded
/// to avoid a cycle. This is neither a root MAC nor proof of any factor's fulfillment.
///
/// # Errors
/// Refuses manifests exceeding version/record/encoded bounds or malformed serialization.
pub fn prepare_native_factor_configuration(
    manifest: &RootProtectionManifest,
) -> Result<FactorConfigurationBinding, ProtectionError> {
    let mut encoded = BoundedJson {
        bytes: Vec::new(),
        exceeded: false,
    };
    let result = serde_json::to_writer(&mut encoded, manifest);
    if encoded.exceeded {
        return Err(ProtectionError::OversizedManifest);
    }
    result.map_err(|_| ProtectionError::MalformedEncoding("native configuration".into()))?;
    validate_manifest_bounds(manifest)?;
    let mut value: Value = serde_json::from_slice(&encoded.bytes)
        .map_err(|_| ProtectionError::MalformedEncoding("native configuration".into()))?;
    let object = value
        .as_object_mut()
        .ok_or(ProtectionError::ContextMismatch)?;
    object.remove("authB64");
    object.remove("factorConfiguration");
    let canonical = canonicalize_to_bytes(&serde_json::json!({
        "version": 1,
        "profile": "native-password-store",
        "manifest": value,
    }))?;
    let mut hash = Sha256::new();
    hash.update(DOMAIN);
    hash.update([0]);
    hash.update(canonical);
    Ok(FactorConfigurationBinding::native_from_digest(
        &hash.finalize().into(),
    ))
}

/// Compare stored binding with the actual native configuration; no owner permit results.
///
/// # Errors
/// Refuses missing/stale binding, malformed configurations or exceeded bounds.
pub fn assert_native_factor_configuration(
    manifest: &RootProtectionManifest,
) -> Result<(), ProtectionError> {
    if manifest.factor_configuration.as_ref()
        != Some(&prepare_native_factor_configuration(manifest)?)
    {
        return Err(ProtectionError::ContextMismatch);
    }
    Ok(())
}

#[cfg(test)]
#[path = "native_factor_configuration_tests.rs"]
mod tests;
