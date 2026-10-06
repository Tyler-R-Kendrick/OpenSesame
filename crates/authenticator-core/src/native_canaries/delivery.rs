use super::{error, read, time};
use crate::retired_gate::{Gate, NativeGateError};
use opensesame_human_vault::credential_canaries::receiver::Reservation;
#[cfg_attr(feature = "ffi", derive(uniffi::Record))]
pub struct NativeCanaryDelivery {
    pub state_record: String,
    pub reservation: String,
    pub destination: String,
    pub packet: String,
}
#[cfg_attr(feature = "ffi", derive(uniffi::Record))]
pub struct NativeCanaryFinishResult {
    pub state_record: String,
    pub delivered: bool,
}
fn reservation(raw: &str) -> Result<Reservation, NativeGateError> {
    if raw.len() > 16384 {
        return Err(NativeGateError::InvalidRecord);
    }
    serde_json::from_str(raw).map_err(error)
}
/// # Errors
/// Reserves a durable bounded attempt; platform sender awaits network after releasing its lock.
#[cfg_attr(feature = "ffi", uniffi::export)]
#[allow(clippy::needless_pass_by_value)]
pub fn native_canary_reserve(
    gate_record: String,
    state_record: String,
    package_id: Option<String>,
    testing: bool,
    now: String,
) -> Result<Option<NativeCanaryDelivery>, NativeGateError> {
    let gate = Gate::parse(&gate_record)?;
    let mut state = read(&gate, Some(&state_record))?;
    let Some(config) = &state.receiver else {
        return Ok(None);
    };
    let Some(reserved) = state
        .outbox
        .reserve(config, package_id.as_deref(), testing, time(&now)?)
        .map_err(error)?
    else {
        return Ok(None);
    };
    Ok(Some(NativeCanaryDelivery {
        state_record: state.encode().map_err(error)?,
        destination: reserved.config.provision.destination().map_err(error)?,
        packet: serde_json::to_string(&reserved.packet).map_err(error)?,
        reservation: serde_json::to_string(&reserved).map_err(error)?,
    }))
}
/// # Errors
/// Check immediately before nonblocking dispatch under the same exclusion as owner revocation.
#[cfg_attr(feature = "ffi", uniffi::export)]
#[allow(clippy::needless_pass_by_value)]
pub fn native_canary_dispatch_current(
    gate_record: String,
    state_record: String,
    reserved: String,
    now: String,
) -> Result<bool, NativeGateError> {
    let gate = Gate::parse(&gate_record)?;
    let state = read(&gate, Some(&state_record))?;
    let Some(config) = &state.receiver else {
        return Ok(false);
    };
    let reserved = reservation(&reserved)?;
    if reserved.testing
        && !state.owner_test_current(&reserved.packet.package_id, gate.encode()?.as_bytes())
    {
        return Ok(false);
    }
    Ok(state.outbox.is_current(config, &reserved, time(&now)?))
}
/// # Errors
/// A changed binding, owner cancellation or unauthenticated HTTP response cannot mark delivery.
#[cfg_attr(feature = "ffi", uniffi::export)]
#[allow(clippy::needless_pass_by_value)]
pub fn native_canary_finish(
    gate_record: String,
    state_record: String,
    reserved: String,
    acknowledgement: Option<String>,
    now: String,
) -> Result<NativeCanaryFinishResult, NativeGateError> {
    let gate = Gate::parse(&gate_record)?;
    let mut state = read(&gate, Some(&state_record))?;
    let reserved = reservation(&reserved)?;
    if reserved.testing
        && !state.owner_test_current(&reserved.packet.package_id, gate.encode()?.as_bytes())
    {
        return Ok(NativeCanaryFinishResult {
            state_record: state.encode().map_err(error)?,
            delivered: false,
        });
    }
    let delivered = if let Some(config) = &mut state.receiver {
        state
            .outbox
            .finish(config, &reserved, acknowledgement.as_deref(), time(&now)?)
    } else {
        false
    };
    if delivered {
        state.remove_owner_test(&reserved.packet.package_id);
    }
    Ok(NativeCanaryFinishResult {
        state_record: state.encode().map_err(error)?,
        delivered,
    })
}
