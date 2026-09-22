//! Durable epoch counters for independent-authority duress incidents.

use opensesame_authz::duress::{DenyCeiling, EpochTriple};

/// Monotonic epoch counters frozen into Host-side incident records.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct DurableEpochs {
    pub policy_epoch: u64,
    pub key_epoch: u64,
    pub incident_epoch: u64,
}

impl DurableEpochs {
    #[must_use]
    pub const fn new(policy_epoch: u64, key_epoch: u64, incident_epoch: u64) -> Self {
        Self {
            policy_epoch,
            key_epoch,
            incident_epoch,
        }
    }

    #[must_use]
    pub const fn as_triple(self) -> EpochTriple {
        EpochTriple {
            policy_epoch: self.policy_epoch,
            key_epoch: self.key_epoch,
            incident_epoch: self.incident_epoch,
        }
    }

    /// Advance incident epoch only (INV-13 monotonic narrowing).
    #[must_use]
    pub const fn bump_incident(self) -> Self {
        Self {
            incident_epoch: self.incident_epoch.saturating_add(1),
            ..self
        }
    }

    #[must_use]
    pub const fn matches(self, other: Self) -> bool {
        self.policy_epoch == other.policy_epoch
            && self.key_epoch == other.key_epoch
            && self.incident_epoch == other.incident_epoch
    }
}

impl From<DurableEpochs> for EpochTriple {
    fn from(value: DurableEpochs) -> Self {
        value.as_triple()
    }
}

/// Build the deny ceiling that accompanies an active independent hold.
#[must_use]
pub fn ceiling_for_hold(ceiling_ref: &str, epochs: DurableEpochs) -> DenyCeiling {
    DenyCeiling::deny_all_boundaries(ceiling_ref, epochs.as_triple())
}
