use super::{error, read, time};
use crate::retired_gate::{Gate, NativeGateError};
use opensesame_human_vault::credential_canaries::{
    receiver::Provision, ArtifactKind, Phase, ValidatorBinding,
};
use zeroize::Zeroizing;
#[cfg_attr(feature = "ffi", derive(uniffi::Enum))]
pub enum NativeCanaryMutation {
    Create {
        kind: String,
    },
    Remove {
        artifact_id: String,
    },
    ClearEvents,
    ConfigureReceiver {
        provision: String,
    },
    EnableReceiver {
        enabled: bool,
    },
    RemoveReceiver,
    TestReceiver,
    ExportValidator {
        artifact_id: String,
        presented_id: String,
    },
}
#[cfg_attr(feature = "ffi", derive(uniffi::Record))]
pub struct NativeCanaryOwnerResult {
    pub gate_record: String,
    pub state_record: String,
    pub output: String,
}
/// # Errors
/// Called only after fresh OS owner proof and a captured real-session epoch; the platform must
/// recheck that exact epoch and stored gate/state revisions before committing this result.
#[cfg_attr(feature = "ffi", uniffi::export)]
#[allow(clippy::needless_pass_by_value)]
pub fn native_canary_manage(
    gate_record: String,
    current: String,
    state_record: Option<String>,
    operation: NativeCanaryMutation,
    now: String,
) -> Result<NativeCanaryOwnerResult, NativeGateError> {
    let current = Zeroizing::new(current);
    let mut gate = Gate::parse(&gate_record)?;
    gate.owner(current.as_bytes())?;
    if gate.vault_identity.is_none() {
        gate.vault_identity = Some(uuid::Uuid::new_v4().to_string());
    }
    let mut state = read(&gate, state_record.as_deref())?;
    let now = time(&now)?;
    let output = match operation {
        NativeCanaryMutation::Create { kind } => {
            let kind: ArtifactKind =
                serde_json::from_value(serde_json::Value::String(kind)).map_err(error)?;
            if matches!(
                kind,
                ArtifactKind::TokenGeneration | ArtifactKind::AgentLease
            ) {
                return Err(NativeGateError::EnrollmentRefused);
            }
            let artifact = state
                .registry
                .create(
                    kind,
                    &now.to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
                )
                .map_err(error)?;
            serde_json::to_string(&artifact).map_err(error)?
        }
        NativeCanaryMutation::Remove { artifact_id } => {
            state
                .registry
                .artifacts
                .retain(|artifact| artifact.id != artifact_id);
            String::new()
        }
        NativeCanaryMutation::ClearEvents => {
            state.registry.events.clear();
            String::new()
        }
        NativeCanaryMutation::ConfigureReceiver { provision } => {
            let provision = Zeroizing::new(provision);
            state
                .configure_receiver(Provision::parse(&provision).map_err(error)?, now)
                .map_err(error)?;
            String::new()
        }
        NativeCanaryMutation::EnableReceiver { enabled } => {
            state.enable_receiver(enabled, now).map_err(error)?;
            String::new()
        }
        NativeCanaryMutation::RemoveReceiver => {
            state.remove_receiver();
            String::new()
        }
        NativeCanaryMutation::TestReceiver => {
            let id = state.test_receiver(now).map_err(error)?.unwrap_or_default();
            if !id.is_empty() {
                state
                    .pin_owner_test(&id, gate.encode()?.as_bytes())
                    .map_err(error)?;
            }
            id
        }
        NativeCanaryMutation::ExportValidator {
            artifact_id,
            presented_id,
        } => {
            let presented_id = Zeroizing::new(presented_id);
            let artifact = state
                .registry
                .artifacts
                .iter()
                .find(|artifact| artifact.id == artifact_id)
                .ok_or(NativeGateError::EnrollmentRefused)?;
            let binding =
                ValidatorBinding::from_artifact(artifact, &presented_id).map_err(error)?;
            let observed = state
                .registry
                .observe_bound(
                    &artifact_id,
                    &presented_id,
                    Phase::ArtifactDispatched,
                    &now.to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
                )
                .map_err(error)?;
            if let Some(event) = observed.event {
                if state.queue(&(&event).into(), now).is_err() {
                    state.outbox.failed = state.outbox.failed.saturating_add(1);
                }
            }
            serde_json::to_string(&binding).map_err(error)?
        }
    };
    Ok(NativeCanaryOwnerResult {
        gate_record: gate.encode()?,
        state_record: state.encode().map_err(error)?,
        output,
    })
}
