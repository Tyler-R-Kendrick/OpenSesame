//! Durable in-process store for Host independent-authority state.
//!
//! Production persistence is a PEER/daemon concern; this store is the typed
//! crash-consistent model Host tests and local receivers share.

use std::collections::BTreeMap;

use crate::duress::hold::IndependentHold;
use crate::duress::ops::{IncidentState, QuarantineRecord};

/// Host-side durable duress ledger keyed by incident id.
#[derive(Clone, Debug, Default)]
pub struct DuressAuthorityStore {
    holds: BTreeMap<String, IndependentHold>,
    quarantines: BTreeMap<String, QuarantineRecord>,
    incident_states: BTreeMap<String, IncidentState>,
}

impl DuressAuthorityStore {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    pub fn put_hold(&mut self, hold: IndependentHold) {
        self.incident_states
            .entry(hold.incident_id.clone())
            .or_insert(IncidentState::Active);
        self.holds.insert(hold.incident_id.clone(), hold);
    }

    #[must_use]
    pub fn hold(&self, incident_id: &str) -> Option<&IndependentHold> {
        self.holds.get(incident_id)
    }

    pub fn hold_mut(&mut self, incident_id: &str) -> Option<&mut IndependentHold> {
        self.holds.get_mut(incident_id)
    }

    pub fn put_quarantine(&mut self, record: QuarantineRecord) {
        self.quarantines.insert(record.peer_ref.clone(), record);
    }

    #[must_use]
    pub fn quarantine(&self, peer_ref: &str) -> Option<&QuarantineRecord> {
        self.quarantines.get(peer_ref)
    }

    #[must_use]
    pub fn is_peer_quarantined(&self, peer_ref: &str) -> bool {
        self.quarantines.get(peer_ref).is_some_and(|q| q.active)
    }

    pub fn set_incident_state(&mut self, incident_id: &str, state: IncidentState) {
        self.incident_states.insert(incident_id.to_string(), state);
    }

    #[must_use]
    pub fn incident_state(&self, incident_id: &str) -> Option<IncidentState> {
        self.incident_states.get(incident_id).copied()
    }
}
