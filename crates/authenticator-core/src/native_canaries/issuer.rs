//! Installed privileged issuer adapter. It is never constructed from agent/browser input.
use super::{error, read, time, NativeCanaryOwnerResult};
use crate::retired_gate::{Gate, NativeGateError};
use opensesame_human_vault::credential_canaries::Artifact;
use std::sync::Arc;
use zeroize::Zeroizing;

/// A human-installed adapter authenticates the actual Host separately and resolves its issued
/// UUID record. Local password/OS proof is not Host authorization. Implementations must bound
/// transport, reject redirects, and return only the authenticated retirement's closed metadata.
#[cfg_attr(feature = "ffi", uniffi::export(foreign))]
pub trait NativeCanaryIssuerProvider: Send + Sync {
    /// # Errors
    /// Refuses missing Host authentication, absent issuance, or unsuccessful atomic revocation.
    fn retire_authenticated(
        &self,
        issuer_record_ref: String,
        expected_vault_identity: String,
    ) -> Result<String, NativeGateError>;
}

/// # Errors
/// Called only with an installed authenticated issuer capability after fresh OS owner proof.
/// Caller must preserve original real-session epoch and CAS gate/state after this function returns.
#[cfg_attr(feature = "ffi", uniffi::export)]
#[allow(clippy::needless_pass_by_value)]
pub fn native_canary_retire_issued(
    gate_record: String,
    current: String,
    state_record: Option<String>,
    issuer_record_ref: String,
    provider: Arc<dyn NativeCanaryIssuerProvider>,
    now: String,
) -> Result<NativeCanaryOwnerResult, NativeGateError> {
    let current = Zeroizing::new(current);
    let mut gate = Gate::parse(&gate_record)?;
    gate.owner(current.as_bytes())?;
    if gate.vault_identity.is_none() {
        gate.vault_identity = Some(uuid::Uuid::new_v4().to_string());
    }
    let mut state = read(&gate, state_record.as_deref())?;
    time(&now)?;
    if state.registry.artifacts.len() >= opensesame_human_vault::credential_canaries::MAX_ARTIFACTS
        || state
            .registry
            .artifacts
            .iter()
            .any(|artifact| artifact.id == issuer_record_ref)
    {
        return Err(NativeGateError::EnrollmentRefused);
    }
    uuid::Uuid::parse_str(&issuer_record_ref).map_err(error)?;
    // No store/platform edit lock or root keys are retained across independent Host transport.
    let raw = provider.retire_authenticated(
        issuer_record_ref.clone(),
        state.registry.vault_identity.clone(),
    )?;
    if raw.len() > 4096 {
        return Err(NativeGateError::InvalidRecord);
    }
    let artifact: Artifact = serde_json::from_str(&raw).map_err(error)?;
    state
        .registry
        .import_verified_retirement(&issuer_record_ref, artifact)
        .map_err(error)?;
    Ok(NativeCanaryOwnerResult {
        gate_record: gate.encode()?,
        state_record: state.encode().map_err(error)?,
        output: String::new(),
    })
}
