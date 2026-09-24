//! Purpose-bound Host operations for incident / quarantine / hold / recovery.

use crate::duress::epochs::{ceiling_for_hold, DurableEpochs};
use crate::duress::hold::{admits_recovery_attempt, HoldDuration, HoldPhase, IndependentHold};
use crate::duress::store::DuressAuthorityStore;
use opensesame_authz::duress::{
    evaluate_deny_ceiling, BoundaryOp, CeilingVerdict, DenyCeiling, DispatchState,
};

/// Incident lifecycle mirrored from the contracts package (INV-13).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum IncidentState {
    Active,
    RecoveryRequested,
    Resolved,
    Superseded,
}

impl IncidentState {
    #[must_use]
    pub const fn can_transition(self, to: Self) -> bool {
        match self {
            Self::Active => matches!(
                to,
                Self::Active | Self::RecoveryRequested | Self::Resolved | Self::Superseded
            ),
            Self::RecoveryRequested => matches!(
                to,
                Self::RecoveryRequested | Self::Resolved | Self::Superseded
            ),
            Self::Resolved => matches!(to, Self::Resolved | Self::Superseded),
            Self::Superseded => matches!(to, Self::Superseded),
        }
    }
}

/// Purpose tags for Host duress ops — unsigned / unbound calls are refused.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DuressPurpose {
    AcceptIndependentHold,
    QuarantinePeer,
    RequestRecovery,
    ResolveRecovery,
    SupersedeIncident,
}

impl DuressPurpose {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::AcceptIndependentHold => "duress.accept_independent_hold",
            Self::QuarantinePeer => "duress.quarantine_peer",
            Self::RequestRecovery => "duress.request_recovery",
            Self::ResolveRecovery => "duress.resolve_recovery",
            Self::SupersedeIncident => "duress.supersede_incident",
        }
    }
}

/// Peer quarantine accepted by this Host for an incident epoch.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct QuarantineRecord {
    pub peer_ref: String,
    pub incident_id: String,
    pub epochs: DurableEpochs,
    pub active: bool,
    pub accepted_at_ms: u64,
}

/// Refusal for a purpose-bound Host duress operation.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DuressOpError {
    PurposeMismatch {
        expected: &'static str,
        presented: String,
    },
    Unsupported,
    UnknownIncident,
    HoldNotActive,
    RecoveryNotAdmitted,
    AuthorityMismatch,
    EpochMismatch,
    InvalidTransition,
    StillHeld,
    HoldExists,
}

impl DuressOpError {
    #[must_use]
    pub const fn code(&self) -> &'static str {
        match self {
            Self::PurposeMismatch { .. } => "purpose_mismatch",
            Self::Unsupported => "unsupported",
            Self::UnknownIncident => "unknown_incident",
            Self::HoldNotActive => "hold_not_active",
            Self::RecoveryNotAdmitted => "recovery_not_admitted",
            Self::AuthorityMismatch => "authority_mismatch",
            Self::EpochMismatch => "epoch_mismatch",
            Self::InvalidTransition => "invalid_transition",
            Self::StillHeld => "still_held",
            Self::HoldExists => "hold_exists",
        }
    }
}

fn require_purpose(expected: DuressPurpose, presented: &str) -> Result<(), DuressOpError> {
    if presented == expected.as_str() {
        Ok(())
    } else {
        Err(DuressOpError::PurposeMismatch {
            expected: expected.as_str(),
            presented: presented.to_string(),
        })
    }
}

/// Accept an independent-authority hold. Purpose-bound; durable epochs required.
///
/// A hold already accepted for the incident is never overwritten: a re-delivery
/// of the identical hold is idempotent and returns the stored one untouched
/// (phase and clock included), another authority is refused, and the same
/// authority changing the terms (duration, epochs, ceiling) is refused too —
/// a re-accept must not reset a timed hold, reopen a resolved one, or swap
/// its ceiling.
///
/// # Errors
///
/// Returns [`DuressOpError::PurposeMismatch`] when `purpose` is unbound,
/// [`DuressOpError::AuthorityMismatch`] when another authority holds the
/// incident, and [`DuressOpError::HoldExists`] for changed terms.
#[allow(clippy::too_many_arguments)]
pub fn accept_independent_hold(
    store: &mut DuressAuthorityStore,
    purpose: &str,
    hold_id: impl Into<String>,
    authority_ref: impl Into<String>,
    incident_id: impl Into<String>,
    epochs: DurableEpochs,
    duration: HoldDuration,
    accepted_at_ms: u64,
    ceiling_ref: impl Into<String>,
) -> Result<IndependentHold, DuressOpError> {
    require_purpose(DuressPurpose::AcceptIndependentHold, purpose)?;
    let hold = IndependentHold {
        hold_id: hold_id.into(),
        authority_ref: authority_ref.into(),
        incident_id: incident_id.into(),
        epochs,
        duration,
        accepted_at_ms,
        phase: HoldPhase::Active,
        ceiling_ref: ceiling_ref.into(),
    };
    if let Some(existing) = store.hold(&hold.incident_id) {
        if existing.authority_ref != hold.authority_ref {
            return Err(DuressOpError::AuthorityMismatch);
        }
        let same_terms = existing.hold_id == hold.hold_id
            && existing.epochs.matches(hold.epochs)
            && existing.duration == hold.duration
            && existing.ceiling_ref == hold.ceiling_ref;
        return if same_terms {
            Ok(existing.clone())
        } else {
            Err(DuressOpError::HoldExists)
        };
    }
    store.put_hold(hold.clone());
    Ok(hold)
}

/// Quarantine a peer under the active incident epochs.
///
/// # Errors
///
/// [`DuressOpError::PurposeMismatch`] for any purpose but `duress.quarantine_peer`;
/// [`DuressOpError::UnknownIncident`] when no hold exists for `incident_id`;
/// [`DuressOpError::EpochMismatch`] when `epochs` are not the hold's; and
/// [`DuressOpError::HoldNotActive`] once the hold no longer holds capabilities.
pub fn quarantine_peer(
    store: &mut DuressAuthorityStore,
    purpose: &str,
    peer_ref: impl Into<String>,
    incident_id: &str,
    epochs: DurableEpochs,
    accepted_at_ms: u64,
) -> Result<QuarantineRecord, DuressOpError> {
    require_purpose(DuressPurpose::QuarantinePeer, purpose)?;
    let Some(hold) = store.hold(incident_id) else {
        return Err(DuressOpError::UnknownIncident);
    };
    if !hold.epochs.matches(epochs) {
        return Err(DuressOpError::EpochMismatch);
    }
    if !hold.capabilities_held() {
        return Err(DuressOpError::HoldNotActive);
    }
    let record = QuarantineRecord {
        peer_ref: peer_ref.into(),
        incident_id: incident_id.to_string(),
        epochs,
        active: true,
        accepted_at_ms,
    };
    store.put_quarantine(record.clone());
    Ok(record)
}

/// File a recovery request. Never clears the hold.
///
/// # Errors
///
/// [`DuressOpError::PurposeMismatch`] for any purpose but `duress.request_recovery`;
/// [`DuressOpError::UnknownIncident`] when no hold exists for `incident_id`;
/// and [`DuressOpError::RecoveryNotAdmitted`] while the hold's delay has not
/// elapsed (or the hold is already resolved or superseded).
pub fn request_recovery(
    store: &mut DuressAuthorityStore,
    purpose: &str,
    incident_id: &str,
    now_ms: u64,
) -> Result<(), DuressOpError> {
    require_purpose(DuressPurpose::RequestRecovery, purpose)?;
    let hold = store
        .hold_mut(incident_id)
        .ok_or(DuressOpError::UnknownIncident)?;
    hold.observe_clock(now_ms);
    if !admits_recovery_attempt(hold) {
        return Err(DuressOpError::RecoveryNotAdmitted);
    }
    hold.phase = HoldPhase::RecoveryRequested;
    store.set_incident_state(incident_id, IncidentState::RecoveryRequested);
    Ok(())
}

/// Explicit authority resolution. Alert ACK / clock expiry cannot call this.
///
/// # Errors
///
/// [`DuressOpError::PurposeMismatch`] for any purpose but `duress.resolve_recovery`;
/// [`DuressOpError::UnknownIncident`] when no hold exists for `incident_id`;
/// [`DuressOpError::AuthorityMismatch`] when `authority_ref` is not the
/// hold's authority; [`DuressOpError::EpochMismatch`] when the presented
/// epochs are stale; and [`DuressOpError::InvalidTransition`] from a hold
/// that is already resolved or superseded.
pub fn resolve_recovery(
    store: &mut DuressAuthorityStore,
    purpose: &str,
    incident_id: &str,
    authority_ref: &str,
    presented_epochs: DurableEpochs,
) -> Result<(), DuressOpError> {
    require_purpose(DuressPurpose::ResolveRecovery, purpose)?;
    let hold = store
        .hold_mut(incident_id)
        .ok_or(DuressOpError::UnknownIncident)?;
    if hold.authority_ref != authority_ref {
        return Err(DuressOpError::AuthorityMismatch);
    }
    if !hold.epochs.matches(presented_epochs) {
        return Err(DuressOpError::EpochMismatch);
    }
    if !matches!(
        hold.phase,
        HoldPhase::Active | HoldPhase::DelayElapsed | HoldPhase::RecoveryRequested
    ) {
        return Err(DuressOpError::InvalidTransition);
    }
    hold.phase = HoldPhase::Resolved;
    store.set_incident_state(incident_id, IncidentState::Resolved);
    Ok(())
}

/// Supersede an incident when a newer epoch narrows scope.
///
/// Superseding lifts the hold's deny ceiling, so it demands what resolving
/// does: the authority that accepted the hold and the hold's current epochs.
///
/// # Errors
///
/// Returns [`DuressOpError::AuthorityMismatch`] / [`DuressOpError::EpochMismatch`]
/// when the caller does not present the hold's own authority and epochs.
pub fn supersede_incident(
    store: &mut DuressAuthorityStore,
    purpose: &str,
    incident_id: &str,
    authority_ref: &str,
    presented_epochs: DurableEpochs,
) -> Result<(), DuressOpError> {
    require_purpose(DuressPurpose::SupersedeIncident, purpose)?;
    let hold = store
        .hold_mut(incident_id)
        .ok_or(DuressOpError::UnknownIncident)?;
    if hold.authority_ref != authority_ref {
        return Err(DuressOpError::AuthorityMismatch);
    }
    if !hold.epochs.matches(presented_epochs) {
        return Err(DuressOpError::EpochMismatch);
    }
    hold.phase = HoldPhase::Superseded;
    store.set_incident_state(incident_id, IncidentState::Superseded);
    Ok(())
}

/// Active ceiling for an incident, if Host still holds capability boundaries.
#[must_use]
pub fn active_ceiling(store: &DuressAuthorityStore, incident_id: &str) -> Option<DenyCeiling> {
    let hold = store.hold(incident_id)?;
    if !hold.capabilities_held() {
        return None;
    }
    Some(ceiling_for_hold(&hold.ceiling_ref, hold.epochs))
}

/// Gate a Host boundary op against the incident's independent-authority ceiling.
#[must_use]
pub fn gate_boundary(
    store: &DuressAuthorityStore,
    incident_id: Option<&str>,
    op: BoundaryOp,
    dispatch: &DispatchState,
    presented_epochs: Option<DurableEpochs>,
) -> CeilingVerdict {
    let ceiling = incident_id.and_then(|id| active_ceiling(store, id));
    evaluate_deny_ceiling(
        ceiling.as_ref(),
        op,
        dispatch,
        presented_epochs.map(DurableEpochs::as_triple),
    )
}
