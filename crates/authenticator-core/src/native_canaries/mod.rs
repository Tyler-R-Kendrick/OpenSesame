//! Native detection realm: platform OS protection and fresh OS owner proof remain mandatory.
mod delivery;
mod issuer;
mod owner;
use crate::retired_gate::{Gate, NativeGateError};
use chrono::{DateTime, SecondsFormat, Timelike, Utc};
use opensesame_human_vault::credential_canaries::{DeviceState, Observation, Phase};
#[cfg(test)]
mod tests;
pub use delivery::{
    native_canary_dispatch_current, native_canary_finish, native_canary_reserve,
    NativeCanaryDelivery, NativeCanaryFinishResult,
};
pub use issuer::{native_canary_retire_issued, NativeCanaryIssuerProvider};
pub use owner::{native_canary_manage, NativeCanaryMutation, NativeCanaryOwnerResult};
const TOMB: &str = "native-wallet-credential-observations.v1";
fn error(_: impl std::fmt::Display) -> NativeGateError {
    NativeGateError::InvalidRecord
}
fn time(raw: &str) -> Result<DateTime<Utc>, NativeGateError> {
    let now = DateTime::parse_from_rfc3339(raw)
        .map_err(error)?
        .with_timezone(&Utc);
    if now.nanosecond() >= 1_000_000_000 || now.to_rfc3339_opts(SecondsFormat::Millis, true) != raw
    {
        return Err(NativeGateError::InvalidRecord);
    }
    Ok(now)
}
fn read(gate: &Gate, raw: Option<&str>) -> Result<DeviceState, NativeGateError> {
    let identity = gate
        .vault_identity
        .as_ref()
        .ok_or(NativeGateError::OwnerRequired)?;
    raw.map_or_else(
        || Ok(DeviceState::new(TOMB, identity)),
        |raw| DeviceState::parse(raw, TOMB, identity).map_err(error),
    )
}
/// # Errors
/// Platform callers must already hold a genuine real session before exposing redacted status.
#[cfg_attr(feature = "ffi", uniffi::export)]
#[allow(clippy::needless_pass_by_value)]
pub fn native_canary_status(
    gate_record: String,
    state_record: Option<String>,
) -> Result<String, NativeGateError> {
    let gate = Gate::parse(&gate_record)?;
    if gate.vault_identity.is_none() && state_record.is_none() {
        return Ok(serde_json::json!({"artifacts":[],"events":[],"receiver":null,"queued":0,"failed":0,"needsOwnerMigration":true}).to_string());
    }
    Ok(read(&gate, state_record.as_deref())?.status().to_string())
}
#[cfg_attr(feature = "ffi", derive(uniffi::Record))]
pub struct NativeCanaryObservation {
    pub state_record: String,
    pub decision: String,
    pub observed: bool,
}
/// # Errors
/// Optional sender hooks normalize only the latest existing closed password event.
#[cfg_attr(feature = "ffi", uniffi::export)]
#[allow(clippy::needless_pass_by_value)]
pub fn native_canary_queue_latest_password(
    gate_record: String,
    state_record: Option<String>,
    now: String,
) -> Result<Option<String>, NativeGateError> {
    let Some(raw) = state_record else {
        return Ok(None);
    };
    let gate = Gate::parse(&gate_record)?;
    let mut state = read(&gate, Some(&raw))?;
    if let Some(event) = gate.records.events.last() {
        let metadata =
            opensesame_human_vault::credential_canaries::receiver::Metadata::from_password(
                event,
                &state.registry.vault_identity,
            )
            .map_err(error)?;
        if state.queue(&metadata, time(&now)?).is_err() {
            state.outbox.failed = state.outbox.failed.saturating_add(1);
        }
    }
    state.encode().map(Some).map_err(error)
}
/// # Errors
/// This detector path never verifies a submitted vault password or returns real-session admission.
#[cfg_attr(feature = "ffi", uniffi::export)]
#[allow(clippy::needless_pass_by_value)]
pub fn native_canary_observe(
    gate_record: String,
    state_record: String,
    artifact_id: String,
    presented_id: String,
    phase: String,
    now: String,
) -> Result<NativeCanaryObservation, NativeGateError> {
    let gate = Gate::parse(&gate_record)?;
    let mut state = read(&gate, Some(&state_record))?;
    let now = time(&now)?;
    let phase: Phase = serde_json::from_value(serde_json::Value::String(phase)).map_err(error)?;
    let Observation { decision, event } = state
        .registry
        .observe_bound(
            &artifact_id,
            &presented_id,
            phase,
            &now.to_rfc3339_opts(SecondsFormat::Millis, true),
        )
        .map_err(error)?;
    if let Some(event) = &event {
        if state.queue(&event.into(), now).is_err() {
            state.outbox.failed = state.outbox.failed.saturating_add(1);
        }
    }
    Ok(NativeCanaryObservation {
        state_record: state.encode().map_err(error)?,
        decision: serde_json::to_string(&decision).map_err(error)?,
        observed: event.is_some(),
    })
}
