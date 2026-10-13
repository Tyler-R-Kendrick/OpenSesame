//! Exact bounded retired-password recognition. A match never conveys vault authority.
use argon2::{Algorithm, Argon2, Params, Version};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use subtle::ConstantTimeEq;
use thiserror::Error;
use zeroize::Zeroizing;

pub const MAX_TRAPS: usize = 3;
pub const MAX_EVENTS: usize = 32;
pub const MAX_RECORD_BYTES: usize = 32768;
pub const MAX_PASSWORD_BYTES: usize = 4096;
static KDF_WORK: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[derive(Debug, Error)]
pub enum TrapError {
    #[error("retired credential records are unavailable")]
    Invalid,
    #[error("retired credential derivation failed")]
    Kdf,
    #[error("retired credential derivation is busy")]
    Busy,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Response {
    Reject,
    SyntheticDecoy,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct TrapRecord {
    pub id: String,
    pub created_at: String,
    pub response: Response,
    pub salt: String,
    pub verifier: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DecoyAction {
    VaultWrite,
    AuthorityDenied,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum TrapEvent {
    RetiredCredentialObserved {
        #[serde(rename = "trapId")]
        trap_id: String,
        at: String,
        response: Response,
    },
    SyntheticDecoyInteraction {
        #[serde(rename = "trapId")]
        trap_id: String,
        at: String,
        response: Response,
        action: DecoyAction,
    },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Records {
    pub v: u32,
    pub tomb: String,
    pub traps: Vec<TrapRecord>,
    pub events: Vec<TrapEvent>,
}

fn valid_text(text: &str, max: usize) -> bool {
    !text.is_empty() && text.len() <= max
}
fn valid_date(text: &str) -> bool {
    let b = text.as_bytes();
    if !text.is_ascii() || !(17..=64).contains(&b.len()) || b[10] != b'T' || b.last() != Some(&b'Z')
    {
        return false;
    }
    // Chrono checks the fixed calendar/time fields; close its lowercase/leap-second extensions.
    if b.len() == 17 {
        return chrono::DateTime::parse_from_rfc3339(&format!("{}:00Z", &text[..16])).is_ok();
    }
    if b.len() < 20 || b[16] != b':' || !(b'0'..=b'5').contains(&b[17]) || !b[18].is_ascii_digit() {
        return false;
    }
    if b.len() != 20
        && (b.len() < 22 || b[19] != b'.' || !b[20..b.len() - 1].iter().all(u8::is_ascii_digit))
    {
        return false;
    }
    chrono::DateTime::parse_from_rfc3339(text).is_ok()
}
fn decode<const N: usize>(text: &str) -> Result<[u8; N], TrapError> {
    if text.len() != N.div_ceil(3) * 4 {
        return Err(TrapError::Invalid);
    }
    let bytes = STANDARD.decode(text).map_err(|_| TrapError::Invalid)?;
    if STANDARD.encode(&bytes) != text {
        return Err(TrapError::Invalid);
    }
    bytes.try_into().map_err(|_| TrapError::Invalid)
}

/// Fixed Argon2id v0x13, 64 MiB / three passes / one lane; no normalization.
/// A persisted verifier is an offline guessing oracle. Borrowed inputs remain caller-owned;
/// internal output is wiped on failure and after copying the caller-owned result.
/// # Errors
/// Refuses invalid UTF-8 or inputs outside 1..=4096 bytes, busy work, and KDF failure.
pub fn derive_verifier(password: &[u8], salt: &[u8; 16]) -> Result<[u8; 32], TrapError> {
    if password.is_empty()
        || password.len() > MAX_PASSWORD_BYTES
        || std::str::from_utf8(password).is_err()
    {
        return Err(TrapError::Invalid);
    }
    let _work = KDF_WORK.try_lock().map_err(|error| match error {
        std::sync::TryLockError::WouldBlock => TrapError::Busy,
        std::sync::TryLockError::Poisoned(_) => TrapError::Kdf,
    })?;
    let params = Params::new(65536, 3, 1, Some(32)).map_err(|_| TrapError::Kdf)?;
    let mut output = Zeroizing::new([0; 32]);
    Argon2::new(Algorithm::Argon2id, Version::V0x13, params)
        .hash_password_into(password, salt, output.as_mut())
        .map_err(|_| TrapError::Kdf)?;
    Ok(*output)
}

/// # Errors
/// Refuses malformed salt/verifier encoding before deriving.
pub fn verify_password(password: &[u8], salt: &str, verifier: &str) -> Result<bool, TrapError> {
    let salt = Zeroizing::new(decode::<16>(salt)?);
    let expected = Zeroizing::new(decode::<32>(verifier)?);
    let actual = Zeroizing::new(derive_verifier(password, &salt)?);
    Ok(bool::from(actual.as_ref().ct_eq(expected.as_ref())))
}

impl Records {
    /// # Errors
    /// Refuses foreign contexts, oversized, malformed or ambiguous records.
    pub fn parse(text: &str, context: &str) -> Result<Self, TrapError> {
        if text.len() > MAX_RECORD_BYTES {
            return Err(TrapError::Invalid);
        }
        let records: Self = serde_json::from_str(text).map_err(|_| TrapError::Invalid)?;
        records.validate(context)?;
        Ok(records)
    }

    /// # Errors
    /// Refuses malformed or unbounded data without deriving a password.
    pub fn validate(&self, context: &str) -> Result<(), TrapError> {
        if self.v != 1
            || self.tomb != context
            || !valid_text(context, 256)
            || self.traps.len() > MAX_TRAPS
            || self.events.len() > MAX_EVENTS
        {
            return Err(TrapError::Invalid);
        }
        let mut ids = std::collections::HashSet::new();
        for trap in &self.traps {
            if !valid_text(&trap.id, 128) || !valid_date(&trap.created_at) || !ids.insert(&trap.id)
            {
                return Err(TrapError::Invalid);
            }
            decode::<16>(&trap.salt)?;
            decode::<32>(&trap.verifier)?;
        }
        for event in &self.events {
            let (id, at) = match event {
                TrapEvent::RetiredCredentialObserved { trap_id, at, .. } => (trap_id, at),
                TrapEvent::SyntheticDecoyInteraction {
                    trap_id,
                    at,
                    response,
                    ..
                } if *response == Response::SyntheticDecoy => (trap_id, at),
                TrapEvent::SyntheticDecoyInteraction { .. } => return Err(TrapError::Invalid),
            };
            if !valid_text(id, 128) || !valid_date(at) {
                return Err(TrapError::Invalid);
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests;
