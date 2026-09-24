//! Independent-authority hold model (HOST-A/C).
//!
//! Local clock expiry never auto-unlocks — it only admits a recovery *attempt*.

use crate::duress::epochs::DurableEpochs;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HoldDuration {
    Indefinite,
    DurationMs(u64),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HoldPhase {
    Active,
    /// Timed delay elapsed; still held until explicit authority resolution.
    DelayElapsed,
    RecoveryRequested,
    Resolved,
    Superseded,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct IndependentHold {
    pub hold_id: String,
    pub authority_ref: String,
    pub incident_id: String,
    pub epochs: DurableEpochs,
    pub duration: HoldDuration,
    pub accepted_at_ms: u64,
    pub phase: HoldPhase,
    pub ceiling_ref: String,
}

impl IndependentHold {
    /// Whether Host still enforces capability boundaries for this hold.
    #[must_use]
    pub const fn capabilities_held(&self) -> bool {
        matches!(
            self.phase,
            HoldPhase::Active | HoldPhase::DelayElapsed | HoldPhase::RecoveryRequested
        )
    }

    /// Observe client/host clock. Expiry moves `Active` → `DelayElapsed` only.
    pub fn observe_clock(&mut self, now_ms: u64) {
        if self.phase != HoldPhase::Active {
            return;
        }
        let HoldDuration::DurationMs(ms) = self.duration else {
            return;
        };
        if now_ms.saturating_sub(self.accepted_at_ms) >= ms {
            self.phase = HoldPhase::DelayElapsed;
        }
    }
}

/// Timed holds admit recovery only after delay elapses (or already requested).
/// Indefinite holds admit recovery while capabilities are held.
/// Clock expiry never clears the hold.
#[must_use]
pub fn admits_recovery_attempt(hold: &IndependentHold) -> bool {
    match hold.phase {
        HoldPhase::DelayElapsed | HoldPhase::RecoveryRequested => true,
        HoldPhase::Active => matches!(hold.duration, HoldDuration::Indefinite),
        HoldPhase::Resolved | HoldPhase::Superseded => false,
    }
}
