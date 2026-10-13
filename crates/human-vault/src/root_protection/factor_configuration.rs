//! Optional public binding metadata only. Preservation is not factor authentication.
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{de::Error, Deserialize, Deserializer, Serialize};

/// Versioned opaque configuration digest. No owner permit or factor verdict.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct FactorConfigurationBinding {
    #[serde(deserialize_with = "version_one")]
    version: u32,
    #[serde(deserialize_with = "canonical_digest")]
    digest_b64: String,
}

fn version_one<'de, D: Deserializer<'de>>(input: D) -> Result<u32, D::Error> {
    let version = u32::deserialize(input)?;
    if version != 1 {
        return Err(D::Error::custom("unsupported factor configuration version"));
    }
    Ok(version)
}

fn canonical_digest<'de, D: Deserializer<'de>>(input: D) -> Result<String, D::Error> {
    let text = String::deserialize(input)?;
    if text.len() != 44 {
        return Err(D::Error::custom("invalid factor configuration digest size"));
    }
    let bytes = STANDARD.decode(&text).map_err(D::Error::custom)?;
    if bytes.len() != 32 || STANDARD.encode(&bytes) != text {
        return Err(D::Error::custom("noncanonical factor configuration digest"));
    }
    Ok(text)
}

/// A missing field defaults to None; a present null/malformed object must refuse.
pub(crate) fn deserialize_present<'de, D: Deserializer<'de>>(
    input: D,
) -> Result<Option<FactorConfigurationBinding>, D::Error> {
    FactorConfigurationBinding::deserialize(input).map(Some)
}

impl FactorConfigurationBinding {
    pub(super) fn native_from_digest(digest: &[u8; 32]) -> Self {
        Self {
            version: 1,
            digest_b64: STANDARD.encode(digest),
        }
    }
}
