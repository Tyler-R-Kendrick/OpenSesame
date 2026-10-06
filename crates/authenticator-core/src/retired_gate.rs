//! Native local application admission. This gate does not re-encrypt Multipaz storage.
//! OS-protected persistence and fresh OS owner verification remain platform duties.
use base64::{engine::general_purpose::STANDARD, Engine};
use opensesame_human_vault::retired_credentials::{
    derive_verifier, verify_password, Records, Response,
};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use thiserror::Error;
use zeroize::Zeroizing;

const CONTEXT: &str = "native-wallet-local-admission.v1";

#[derive(Debug, Error)]
#[cfg_attr(feature = "ffi", derive(uniffi::Error))]
pub enum NativeGateError {
    #[error("native credential gate is unavailable or malformed")]
    InvalidRecord,
    #[error("fresh current application password is required")]
    OwnerRequired,
    #[error("credential cannot be enrolled")]
    EnrollmentRefused,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[cfg_attr(feature = "ffi", derive(uniffi::Enum))]
pub enum NativeRealm {
    Rejected,
    Real,
    Synthetic,
}

#[cfg_attr(feature = "ffi", derive(uniffi::Record))]
pub struct NativeAdmission {
    pub realm: NativeRealm,
    pub record: String,
    pub trap_id: Option<String>,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Gate {
    version: u32,
    salt: String,
    verifier: String,
    pub(crate) records: Records,
    #[serde(
        rename = "vaultIdentity",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub(crate) vault_identity: Option<String>,
}

impl Gate {
    pub(crate) fn parse(text: &str) -> Result<Self, NativeGateError> {
        if text.len() > 40_960 {
            return Err(NativeGateError::InvalidRecord);
        }
        let gate: Self = serde_json::from_str(text).map_err(|_| NativeGateError::InvalidRecord)?;
        if gate.version != 1 {
            return Err(NativeGateError::InvalidRecord);
        }
        if gate
            .vault_identity
            .as_ref()
            .is_some_and(|identity| uuid::Uuid::parse_str(identity).is_err())
        {
            return Err(NativeGateError::InvalidRecord);
        }
        Records::parse(
            &serde_json::to_string(&gate.records).map_err(|_| NativeGateError::InvalidRecord)?,
            CONTEXT,
        )
        .map_err(|_| NativeGateError::InvalidRecord)?;
        // Validate encoded lengths even before any matching occurs.
        if STANDARD
            .decode(&gate.salt)
            .map_err(|_| NativeGateError::InvalidRecord)?
            .len()
            != 16
            || STANDARD
                .decode(&gate.verifier)
                .map_err(|_| NativeGateError::InvalidRecord)?
                .len()
                != 32
        {
            return Err(NativeGateError::InvalidRecord);
        }
        Ok(gate)
    }
    pub(crate) fn encode(&self) -> Result<String, NativeGateError> {
        serde_json::to_string(self).map_err(|_| NativeGateError::InvalidRecord)
    }
    pub(crate) fn owner(&self, password: &[u8]) -> Result<(), NativeGateError> {
        if verify_password(password, &self.salt, &self.verifier)
            .map_err(|_| NativeGateError::InvalidRecord)?
        {
            Ok(())
        } else {
            Err(NativeGateError::OwnerRequired)
        }
    }
}

/// Create an application password gate after fresh OS owner authentication.
/// # Errors
/// Refuses empty/unbounded passwords or unavailable derivation.
#[cfg_attr(feature = "ffi", uniffi::export)]
#[allow(clippy::needless_pass_by_value)]
pub fn native_gate_create(password: String) -> Result<String, NativeGateError> {
    let password = Zeroizing::new(password);
    if password.is_empty() || password.len() > 1024 {
        return Err(NativeGateError::EnrollmentRefused);
    }
    let mut salt = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut salt);
    let verifier = Zeroizing::new(
        derive_verifier(password.as_bytes(), &salt).map_err(|_| NativeGateError::InvalidRecord)?,
    );
    Gate {
        version: 1,
        vault_identity: Some(uuid::Uuid::new_v4().to_string()),
        salt: STANDARD.encode(salt),
        verifier: STANDARD.encode(verifier.as_ref()),
        records: Records {
            v: 1,
            tomb: CONTEXT.into(),
            traps: vec![],
            events: vec![],
        },
    }
    .encode()
}

/// Classify before production runtime admission. Rejected retired passwords still produce evidence.
/// # Errors
/// Refuses malformed records, ambiguous matches, or invalid evidence timestamps.
#[cfg_attr(feature = "ffi", uniffi::export)]
#[allow(clippy::needless_pass_by_value)]
pub fn native_gate_admit(
    record: String,
    password: String,
    now: String,
) -> Result<NativeAdmission, NativeGateError> {
    let password = Zeroizing::new(password);
    let mut gate = Gate::parse(&record)?;
    let mut trap_id = None;
    let realm = if let Some(trap) = gate
        .records
        .probe(password.as_bytes())
        .map_err(|_| NativeGateError::InvalidRecord)?
    {
        trap_id = Some(trap.id.clone());
        gate.records
            .observe(&trap, &now)
            .map_err(|_| NativeGateError::InvalidRecord)?;
        match trap.response {
            Response::Reject => NativeRealm::Rejected,
            Response::SyntheticDecoy => NativeRealm::Synthetic,
        }
    } else if gate.owner(password.as_bytes()).is_ok() {
        NativeRealm::Real
    } else {
        NativeRealm::Rejected
    };
    Ok(NativeAdmission {
        realm,
        record: gate.encode()?,
        trap_id,
    })
}

/// Management requires a fresh current password as well as platform owner verification.
/// # Errors
/// Refuses wrong current passwords, collisions, duplicates, or full retention.
#[cfg_attr(feature = "ffi", uniffi::export)]
#[allow(clippy::needless_pass_by_value)]
pub fn native_gate_enroll(
    record: String,
    current: String,
    retired: String,
    synthetic: bool,
    now: String,
) -> Result<String, NativeGateError> {
    let current = Zeroizing::new(current);
    let retired = Zeroizing::new(retired);
    let mut gate = Gate::parse(&record)?;
    gate.owner(current.as_bytes())?;
    if retired.is_empty() || gate.owner(retired.as_bytes()).is_ok() {
        return Err(NativeGateError::EnrollmentRefused);
    }
    gate.records
        .enroll(
            retired.as_bytes(),
            if synthetic {
                Response::SyntheticDecoy
            } else {
                Response::Reject
            },
            &now,
        )
        .map_err(|_| NativeGateError::EnrollmentRefused)?;
    gate.encode()
}

/// Remove a selected trap after fresh owner authentication.
/// # Errors
/// Refuses malformed records or a wrong current password.
#[cfg_attr(feature = "ffi", uniffi::export)]
#[allow(clippy::needless_pass_by_value)]
pub fn native_gate_remove(
    record: String,
    current: String,
    id: String,
) -> Result<String, NativeGateError> {
    let current = Zeroizing::new(current);
    let mut gate = Gate::parse(&record)?;
    gate.owner(current.as_bytes())?;
    gate.records.traps.retain(|trap| trap.id != id);
    gate.encode()
}

/// Clear local evidence after fresh owner authentication.
/// # Errors
/// Refuses malformed records or a wrong current password.
#[cfg_attr(feature = "ffi", uniffi::export)]
#[allow(clippy::needless_pass_by_value)]
pub fn native_gate_clear_events(
    record: String,
    current: String,
) -> Result<String, NativeGateError> {
    let current = Zeroizing::new(current);
    let mut gate = Gate::parse(&record)?;
    gate.owner(current.as_bytes())?;
    gate.records.events.clear();
    gate.encode()
}

/// UI metadata deliberately omits verifiers, salts, and submitted passwords.
/// # Errors
/// Refuses malformed or oversized records.
#[cfg_attr(feature = "ffi", uniffi::export)]
#[allow(clippy::needless_pass_by_value)]
pub fn native_gate_status(record: String) -> Result<String, NativeGateError> {
    let gate = Gate::parse(&record)?;
    let traps: Vec<_> = gate
        .records
        .traps
        .iter()
        .map(|trap| serde_json::json!({"id":trap.id,"response":trap.response}))
        .collect();
    Ok(serde_json::json!({"traps":traps,"events":gate.records.events}).to_string())
}

/// Rotate only the local admission password; a retained trap cannot become current.
/// # Errors
/// Refuses wrong current passwords or a new password colliding with a retained trap.
#[cfg_attr(feature = "ffi", uniffi::export)]
#[allow(clippy::needless_pass_by_value)]
pub fn native_gate_change_password(
    record: String,
    current: String,
    next: String,
) -> Result<String, NativeGateError> {
    let current = Zeroizing::new(current);
    let next = Zeroizing::new(next);
    let mut gate = Gate::parse(&record)?;
    gate.owner(current.as_bytes())?;
    if next.is_empty()
        || next.len() > 1024
        || gate
            .records
            .probe(next.as_bytes())
            .map_err(|_| NativeGateError::InvalidRecord)?
            .is_some()
    {
        return Err(NativeGateError::EnrollmentRefused);
    }
    let mut salt = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut salt);
    let verifier = Zeroizing::new(
        derive_verifier(next.as_bytes(), &salt).map_err(|_| NativeGateError::InvalidRecord)?,
    );
    gate.salt = STANDARD.encode(salt);
    gate.verifier = STANDARD.encode(verifier.as_ref());
    gate.encode()
}

#[cfg(test)]
#[path = "retired_gate_tests.rs"]
mod tests;

/// Closed metadata only; no attacker-controlled URI, response body, or submitted password.
/// # Errors
/// Refuses malformed records, unknown/non-synthetic traps, or invalid timestamps.
#[cfg_attr(feature = "ffi", uniffi::export)]
#[allow(clippy::needless_pass_by_value)]
pub fn native_gate_authority_denied(
    record: String,
    trap_id: String,
    now: String,
) -> Result<String, NativeGateError> {
    use opensesame_human_vault::retired_credentials::{DecoyAction, TrapEvent, MAX_EVENTS};
    let mut gate = Gate::parse(&record)?;
    if !gate
        .records
        .traps
        .iter()
        .any(|trap| trap.id == trap_id && trap.response == Response::SyntheticDecoy)
    {
        return Err(NativeGateError::InvalidRecord);
    }
    gate.records
        .events
        .push(TrapEvent::SyntheticDecoyInteraction {
            trap_id,
            at: now,
            response: Response::SyntheticDecoy,
            action: DecoyAction::AuthorityDenied,
        });
    if gate.records.events.len() > MAX_EVENTS {
        gate.records.events.remove(0);
    }
    gate.records
        .validate(CONTEXT)
        .map_err(|_| NativeGateError::InvalidRecord)?;
    gate.encode()
}
