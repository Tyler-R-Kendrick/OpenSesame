//! Pinned sender preparation: no transport waits while a store/root edit lock is held.
use super::{
    failure,
    storage::{self, ProtectedState},
};
use crate::{store_lock::StoreLock, StoreError};
use opensesame_human_vault::credential_canaries::receiver::{Provision, Reservation};
use std::path::Path;
/// # Errors
/// Provision import requires fresh owner proof; replacing it drops all old unsent packages.
pub fn configure(root: &Path, current: &[u8], provision: &str) -> Result<(), StoreError> {
    let provision = Provision::parse(provision).map_err(failure)?;
    storage::owner_edit(root, current, |state| {
        state
            .configure_receiver(provision, chrono::Utc::now())
            .map_err(failure)
    })
}
/// # Errors
/// Enabling is refused until an authenticated current-binding test acknowledgement exists.
pub fn enable(root: &Path, current: &[u8], enabled: bool) -> Result<(), StoreError> {
    storage::owner_edit(root, current, |state| {
        state
            .enable_receiver(enabled, chrono::Utc::now())
            .map_err(failure)
    })
}
/// # Errors
/// Removes provisioning and all unsent packages without changing local evidence or vault state.
pub fn remove(root: &Path, current: &[u8]) -> Result<(), StoreError> {
    storage::owner_edit(root, current, |state| {
        state.remove_receiver();
        Ok(())
    })
}
/// # Errors
/// A local owner test queues closed metadata, never reports offline delivery as success.
pub fn test(root: &Path, current: &[u8]) -> Result<Option<String>, StoreError> {
    storage::owner_edit(root, current, |state| {
        let queued = state.test_receiver(chrono::Utc::now()).map_err(failure)?;
        if let Some(id) = &queued {
            super::owner_witness::pin(root, state, id.clone())?;
        }
        Ok(queued)
    })
}
/// # Errors
/// Reserves a bounded attempt durably then releases the lock before caller transport.
pub fn reserve(
    root: &Path,
    package_id: Option<&str>,
    testing: bool,
) -> Result<Option<Reservation>, StoreError> {
    let _lock = StoreLock::key_file_edit(root)?;
    let mut protected = ProtectedState::read(root, false)?;
    let Some(config) = &protected.state.receiver else {
        return Ok(None);
    };
    let reservation = protected
        .state
        .outbox
        .reserve(config, package_id, testing, chrono::Utc::now())
        .map_err(failure)?;
    protected.write(root)?;
    Ok(reservation)
}
/// Starts synchronous request construction under revocation exclusion and immediately releases it.
/// The callback must return a nonblocking request future; it must not await a remote response.
/// # Errors
/// Revoked, changed or expired bindings cannot dispatch a queued reservation.
pub fn begin_dispatch<T>(
    root: &Path,
    reservation: &Reservation,
    start: impl FnOnce(&str, &str) -> Result<T, StoreError>,
) -> Result<Option<T>, StoreError> {
    let _lock = StoreLock::key_file_edit(root)?;
    let protected = ProtectedState::read(root, false)?;
    let Some(config) = &protected.state.receiver else {
        return Ok(None);
    };
    if !protected
        .state
        .outbox
        .is_current(config, reservation, chrono::Utc::now())
    {
        return Ok(None);
    }
    if reservation.testing
        && !super::owner_witness::current(root, &protected.state, &reservation.packet.package_id)?
    {
        return Ok(None);
    }
    let destination = config.provision.destination().map_err(failure)?;
    let packet = serde_json::to_string(&reservation.packet).map_err(failure)?;
    start(&destination, &packet).map(Some)
}
/// # Errors
/// Only an authenticated ACK for the unchanged current attempt can mark delivery.
pub fn finish(
    root: &Path,
    reservation: &Reservation,
    ack: Option<&str>,
) -> Result<bool, StoreError> {
    let _lock = StoreLock::key_file_edit(root)?;
    let mut protected = ProtectedState::read(root, false)?;
    if reservation.testing
        && !super::owner_witness::current(root, &protected.state, &reservation.packet.package_id)?
    {
        return Ok(false);
    }
    let Some(config) = &mut protected.state.receiver else {
        return Ok(false);
    };
    let delivered = protected
        .state
        .outbox
        .finish(config, reservation, ack, chrono::Utc::now());
    if delivered {
        protected
            .state
            .owner_test_witnesses
            .retain(|witness| witness.package_id != reservation.packet.package_id);
    }
    protected.write(root)?;
    Ok(delivered)
}

/// # Errors
/// Detection-only flush status exposes counts, never owner data, receiver keys or ciphertext.
pub fn outbox_status(root: &Path) -> Result<serde_json::Value, StoreError> {
    let _lock = StoreLock::key_file_edit(root)?;
    let protected = ProtectedState::read(root, false)?;
    Ok(serde_json::json!({
        "queued": protected.state.outbox.entries.iter()
            .filter(|entry| entry.attempts < opensesame_human_vault::credential_canaries::receiver::MAX_ATTEMPTS).count(),
        "failed": protected.state.outbox.failed,
    }))
}
