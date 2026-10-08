//! Local detection-only canaries, protected independently of the real vault root.
pub mod issuer;
mod owner_witness;
mod private_file;
pub mod receiver;
mod storage;
pub mod validator;
use crate::{store_lock::StoreLock, StoreError};
use opensesame_human_vault::credential_canaries::{
    receiver::Metadata, ArtifactKind, CreatedArtifact, Observation, Phase,
};
use std::path::Path;
fn failure(error: impl std::fmt::Display) -> StoreError {
    StoreError::Other(error.to_string())
}
fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}
/// # Errors
/// Dedicated stdio validation rejects every non-MCP/retired/unknown artifact without production fallthrough.
pub fn handle_mcp(
    root: &Path,
    artifact_id: &str,
    presented_id: &str,
    request: &str,
) -> Result<Option<serde_json::Value>, StoreError> {
    let (phase, response) =
        opensesame_human_vault::credential_canaries::controlled_mcp_response(request)
            .map_err(failure)?;
    let observed = observe(root, artifact_id, presented_id, phase)?;
    if !matches!(
        observed.decision,
        opensesame_human_vault::credential_canaries::Decision::Canary {
            response:
                opensesame_human_vault::credential_canaries::CanaryResponse::SyntheticReadonly,
            ..
        }
    ) {
        return Err(failure("controlled validator authority is unavailable"));
    }
    Ok(response)
}
/// # Errors
/// Every owner management operation proves the current root manifest under the edit lock.
pub fn create(
    root: &Path,
    current: &[u8],
    kind: ArtifactKind,
) -> Result<CreatedArtifact, StoreError> {
    if matches!(
        kind,
        ArtifactKind::TokenGeneration | ArtifactKind::AgentLease
    ) {
        return Err(failure(
            "issued generation canaries require a trusted issuer lifecycle adapter",
        ));
    }
    storage::owner_edit(root, current, |state| {
        state.registry.create(kind, &now()).map_err(failure)
    })
}
/// # Errors
/// Returns redacted metadata only after fresh genuine owner authentication.
pub fn status(root: &Path, current: &[u8]) -> Result<serde_json::Value, StoreError> {
    storage::owner_edit(root, current, |state| Ok(state.status()))
}
/// # Errors
/// Removal grants no production authority and preserves existing evidence.
pub fn remove(root: &Path, current: &[u8], id: &str) -> Result<(), StoreError> {
    storage::owner_edit(root, current, |state| {
        state
            .registry
            .artifacts
            .retain(|artifact| artifact.id != id);
        Ok(())
    })
}
/// # Errors
/// Evidence is cleared only by a fresh genuine owner; no duress or destructive response exists.
pub fn clear_events(root: &Path, current: &[u8]) -> Result<(), StoreError> {
    storage::owner_edit(root, current, |state| {
        state.registry.events.clear();
        Ok(())
    })
}
/// # Errors
/// Requires fresh owner proof and the once-exported identifier matching its registered digest.
pub fn export_validator(
    root: &Path,
    current: &[u8],
    id: &str,
    presented_id: &str,
) -> Result<opensesame_human_vault::credential_canaries::ValidatorBinding, StoreError> {
    storage::owner_edit(root, current, |state| {
        let artifact = state
            .registry
            .artifacts
            .iter()
            .find(|artifact| artifact.id == id)
            .ok_or_else(|| failure("selected artifact is unavailable"))?;
        let binding = opensesame_human_vault::credential_canaries::ValidatorBinding::from_artifact(
            artifact,
            presented_id,
        )
        .map_err(failure)?;
        let observed = state
            .registry
            .observe_bound(id, presented_id, Phase::ArtifactDispatched, &now())
            .map_err(failure)?;
        if let Some(event) = observed.event {
            if state
                .queue(&Metadata::from(&event), chrono::Utc::now())
                .is_err()
            {
                state.outbox.failed = state.outbox.failed.saturating_add(1);
            }
        }
        Ok(binding)
    })
}
/// # Errors
/// Dedicated detector classification gets no protected root, connector or real admission session.
pub fn observe(
    root: &Path,
    artifact_id: &str,
    presented_id: &str,
    phase: Phase,
) -> Result<Observation, StoreError> {
    let _lock = StoreLock::key_file_edit(root)?;
    let mut protected = storage::ProtectedState::read(root, false)?;
    let observed = protected
        .state
        .registry
        .observe_bound(artifact_id, presented_id, phase, &now())
        .map_err(failure)?;
    if let Some(event) = &observed.event {
        if protected
            .state
            .queue(&Metadata::from(event), chrono::Utc::now())
            .is_err()
        {
            protected.state.outbox.failed = protected.state.outbox.failed.saturating_add(1);
        }
    }
    protected.write(root)?;
    Ok(observed)
}
#[cfg(all(test, unix))]
mod authority_regressions;
#[cfg(all(test, unix))]
mod tests;

/// Caller already holds the store edit lock; optional telemetry cannot change admission.
pub(crate) fn queue_password_under_edit(
    root: &Path,
    event: &opensesame_human_vault::retired_credentials::TrapEvent,
) {
    let _ = (|| -> Result<(), StoreError> {
        if private_file::read(root, private_file::Record::State, 196608)?.is_none() {
            return Ok(());
        }
        let mut protected = storage::ProtectedState::read(root, false)?;
        let metadata = Metadata::from_password(event, &protected.state.registry.vault_identity)
            .map_err(failure)?;
        if protected
            .state
            .queue(&metadata, chrono::Utc::now())
            .is_err()
        {
            protected.state.outbox.failed = protected.state.outbox.failed.saturating_add(1);
        }
        protected.write(root)
    })();
}
