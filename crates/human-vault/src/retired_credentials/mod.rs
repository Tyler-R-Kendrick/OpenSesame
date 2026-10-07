//! Exact bounded retired-password recognition. A match never conveys vault authority.
use argon2::{Algorithm, Argon2, Params, Version};
use base64::{engine::general_purpose::STANDARD, Engine};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use subtle::ConstantTimeEq;
use thiserror::Error;
use unicode_normalization::UnicodeNormalization;
use zeroize::Zeroizing;

pub const MAX_TRAPS: usize = 3;
pub const MAX_EVENTS: usize = 32;
pub const MAX_RECORD_BYTES: usize = 32768;
static KDF_WORK: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[derive(Debug, Error)]
pub enum TrapError {
    #[error("retired credential records are unavailable")]
    Invalid,
    #[error("retired credential derivation failed")]
    Kdf,
    #[error("retired credential enrollment is ambiguous or full")]
    Enrollment,
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
    text.len() <= 64 && chrono::DateTime::parse_from_rfc3339(text).is_ok() && text.ends_with('Z')
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
/// # Errors
/// Returns `Kdf` if derivation fails.
pub fn derive_verifier(password: &[u8], salt: &[u8; 16]) -> Result<[u8; 32], TrapError> {
    let _work = KDF_WORK.lock().map_err(|_| TrapError::Kdf)?;
    let params = Params::new(65536, 3, 1, Some(32)).map_err(|_| TrapError::Kdf)?;
    let mut output = [0; 32];
    Argon2::new(Algorithm::Argon2id, Version::V0x13, params)
        .hash_password_into(password, salt, &mut output)
        .map_err(|_| TrapError::Kdf)?;
    Ok(output)
}

/// # Errors
/// Refuses malformed salt/verifier encoding before deriving.
pub fn verify_password(password: &[u8], salt: &str, verifier: &str) -> Result<bool, TrapError> {
    let salt = decode::<16>(salt)?;
    let expected = Zeroizing::new(decode::<32>(verifier)?);
    let actual = Zeroizing::new(derive_verifier(password, &salt)?);
    Ok(bool::from(actual.as_ref().ct_eq(expected.as_ref())))
}

impl Records {
    #[must_use]
    pub fn new(context: &str) -> Self {
        Self {
            v: 1,
            tomb: context.into(),
            traps: Vec::new(),
            events: Vec::new(),
        }
    }

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

    /// # Errors
    /// Refuses invalid records and ambiguous matches; never returns real keys.
    pub fn probe(&self, password: &[u8]) -> Result<Option<TrapRecord>, TrapError> {
        self.validate(&self.tomb)?;
        if password.is_empty() || password.len() > 4096 {
            return Ok(None);
        }
        let mut matched = None;
        for trap in &self.traps {
            if !verify_password(password, &trap.salt, &trap.verifier)? {
                continue;
            }
            if matched.is_some() {
                return Err(TrapError::Enrollment);
            }
            matched = Some(trap.clone());
        }
        Ok(matched)
    }

    /// Owner authorization and collision against current authority belong to the caller.
    /// # Errors
    /// Refuses full/duplicate records or invalid dates before retaining a verifier.
    pub fn enroll(
        &mut self,
        password: &[u8],
        response: Response,
        now: &str,
    ) -> Result<TrapRecord, TrapError> {
        self.validate(&self.tomb)?;
        if password.is_empty() || password.len() > 4096 || std::str::from_utf8(password).is_err() {
            return Err(TrapError::Enrollment);
        }
        let text = std::str::from_utf8(password).map_err(|_| TrapError::Enrollment)?;
        if text.nfkc().ne(text.chars()) {
            return Err(TrapError::Enrollment);
        }
        if self.traps.len() >= MAX_TRAPS || !valid_date(now) || self.probe(password)?.is_some() {
            return Err(TrapError::Enrollment);
        }
        let mut salt = [0; 16];
        rand::thread_rng().fill_bytes(&mut salt);
        let verifier = Zeroizing::new(derive_verifier(password, &salt)?);
        let trap = TrapRecord {
            id: uuid::Uuid::new_v4().to_string(),
            created_at: now.into(),
            response,
            salt: STANDARD.encode(salt),
            verifier: STANDARD.encode(verifier.as_ref()),
        };
        self.traps.push(trap.clone());
        Ok(trap)
    }

    /// # Errors
    /// Refuses foreign trap handles or invalid timestamps; never records submitted text.
    pub fn observe(&mut self, trap: &TrapRecord, now: &str) -> Result<(), TrapError> {
        if !self.traps.contains(trap) || !valid_date(now) {
            return Err(TrapError::Invalid);
        }
        self.events.push(TrapEvent::RetiredCredentialObserved {
            trap_id: trap.id.clone(),
            at: now.into(),
            response: trap.response,
        });
        if self.events.len() > MAX_EVENTS {
            self.events.remove(0);
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests;
