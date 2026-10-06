use base64::{
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
    Engine,
};
use chrono::{DateTime, FixedOffset, Timelike};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;
use zeroize::Zeroizing;

const DOMAIN: &[u8] = b"OpenSesame credential canary v1\0";
const PREFIX: &str = "oscanary:v1:";

#[derive(Debug, Error)]
pub enum CanaryError {
    #[error("controlled canary metadata is invalid or unavailable")]
    Invalid,
    #[error("controlled canary retention limit reached")]
    Limit,
    #[error("controlled canary identifier is ambiguous")]
    Ambiguous,
    #[error("controlled canary context does not match its registered binding")]
    ContextMismatch,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ArtifactKind {
    ConnectionRef,
    McpConfiguration,
    TokenGeneration,
    AgentLease,
}
impl ArtifactKind {
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::ConnectionRef => "connection_ref",
            Self::McpConfiguration => "mcp_configuration",
            Self::TokenGeneration => "token_generation",
            Self::AgentLease => "agent_lease",
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ArtifactContext {
    pub vault_identity: String,
    pub kind: ArtifactKind,
    pub generation: u32,
}
impl ArtifactContext {
    /// # Errors
    /// Refuses empty/oversized identities and zero generations.
    pub fn validate(&self) -> Result<(), CanaryError> {
        if !valid_text(&self.vault_identity) || self.generation == 0 {
            return Err(CanaryError::Invalid);
        }
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Phase {
    Connected,
    Invoked,
    RetiredGenerationObserved,
    ArtifactDispatched,
}

pub(super) fn valid_text(value: &str) -> bool {
    !value.is_empty() && value.encode_utf16().count() <= 256
}
pub(super) fn date(value: &str) -> Result<DateTime<FixedOffset>, CanaryError> {
    if value.len() > 40 || !value.ends_with('Z') {
        return Err(CanaryError::Invalid);
    }
    let result = DateTime::parse_from_rfc3339(value).map_err(|_| CanaryError::Invalid)?;
    if result.nanosecond() >= 1_000_000_000 {
        return Err(CanaryError::Invalid);
    }
    Ok(result)
}
pub(super) fn valid_uuid(value: &str) -> bool {
    uuid::Uuid::parse_str(value).is_ok_and(|id| id.to_string().eq_ignore_ascii_case(value))
}
pub(super) fn decode_digest(value: &str) -> Result<[u8; 32], CanaryError> {
    let bytes = STANDARD.decode(value).map_err(|_| CanaryError::Invalid)?;
    let result = bytes.try_into().map_err(|_| CanaryError::Invalid)?;
    if STANDARD.encode(result) != value {
        return Err(CanaryError::Invalid);
    }
    Ok(result)
}

/// # Errors
/// Refuses noncanonical base64url and identifiers other than exactly 32 bytes.
pub fn decode_presented_id(value: &str) -> Result<[u8; 32], CanaryError> {
    if value.len() != 43 {
        return Err(CanaryError::Invalid);
    }
    let bytes = URL_SAFE_NO_PAD
        .decode(value)
        .map_err(|_| CanaryError::Invalid)?;
    let result = bytes.try_into().map_err(|_| CanaryError::Invalid)?;
    if encode_presented_id(&result) != value {
        return Err(CanaryError::Invalid);
    }
    Ok(result)
}
#[must_use]
pub fn encode_presented_id(value: &[u8; 32]) -> String {
    URL_SAFE_NO_PAD.encode(value)
}
#[must_use]
pub fn mint_presented_id() -> String {
    let mut bytes = Zeroizing::new([0u8; 32]);
    rand::thread_rng().fill_bytes(&mut *bytes);
    encode_presented_id(&bytes)
}

/// # Errors
/// Reserved malformed references fail closed; ordinary references return None.
pub fn parse_reference(value: &str) -> Result<Option<&str>, CanaryError> {
    let Some(id) = value.strip_prefix(PREFIX) else {
        return Ok(None);
    };
    decode_presented_id(id)?;
    Ok(Some(id))
}
/// # Errors
/// Refuses invalid opaque identifiers; never constructs a production reference.
pub fn reference(value: &str) -> Result<String, CanaryError> {
    decode_presented_id(value)?;
    Ok(format!("{PREFIX}{value}"))
}

/// Domain-separated SHA-256 is only for issuer-generated 256-bit IDs, never passwords.
/// # Errors
/// Refuses unbounded context or a noncanonical presented ID.
pub fn digest(context: &ArtifactContext, presented_id: &str) -> Result<[u8; 32], CanaryError> {
    context.validate()?;
    let mut hash = Sha256::new();
    hash.update(DOMAIN);
    for value in [context.vault_identity.as_str(), context.kind.as_str()] {
        let length = u32::try_from(value.len()).map_err(|_| CanaryError::Invalid)?;
        hash.update(length.to_be_bytes());
        hash.update(value.as_bytes());
    }
    hash.update(context.generation.to_be_bytes());
    hash.update(decode_presented_id(presented_id)?);
    Ok(hash.finalize().into())
}
