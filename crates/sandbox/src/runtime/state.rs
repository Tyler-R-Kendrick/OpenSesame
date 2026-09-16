//! Per-run host state and the outcome handed back to the caller.
//!
//! One [`GuestState`] is built per run and dropped with the store. Nothing
//! in it outlives the invocation, so no guest can leave anything behind for
//! the next one — a fresh store per run is the cheapest way to make
//! cross-run state impossible rather than merely discouraged.

use std::sync::Arc;

use crate::boundary::{Broker, RunContext};
use crate::profile::SandboxProfile;
use crate::revoke::RevocationFence;
use crate::runtime::limits::GuestLimiter;

/// Everything the brokered imports may touch.
pub struct GuestState {
    /// Memory and table caps for this run.
    pub limiter: GuestLimiter,
    /// The authority this run executes under.
    pub profile: SandboxProfile,
    /// The host side of the boundary.
    pub broker: Arc<dyn Broker>,
    /// Checked before every brokered call.
    pub fence: RevocationFence,
    /// Identifiers handed to the broker.
    pub run: RunContext,
    /// Bytes the guest emitted as its result.
    pub emitted: Vec<u8>,
    /// How many brokered calls this run made.
    pub broker_calls: u32,
}

impl GuestState {
    /// Record one brokered call.
    pub fn count_call(&mut self) {
        self.broker_calls = self.broker_calls.saturating_add(1);
    }
}

/// What a completed run produced.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RunOutcome {
    /// The guest's own return value. Its meaning is the guest's business;
    /// the host treats it as data.
    pub status: i32,
    /// Bytes the guest emitted, already capped by the profile.
    pub emitted: Vec<u8>,
    /// Fuel actually burned — the honest cost of the run.
    pub fuel_used: u64,
    /// Brokered calls made, refusals included.
    pub broker_calls: u32,
}

impl RunOutcome {
    /// Whether the guest reported success in the conventional way.
    ///
    /// Advisory only: a guest's self-report is not an authority decision,
    /// and nothing in this crate believes it.
    #[must_use]
    pub const fn guest_reported_ok(&self) -> bool {
        self.status == 0
    }
}
