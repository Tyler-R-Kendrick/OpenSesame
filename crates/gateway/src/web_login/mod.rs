//! The Host's web-login runner: the executor side of the step channel, run as
//! an agent-hooks/0.1 session (ADR 0076, ADR 0081, ADR 0150).
//!
//! The gateway already served the *driver's* half — a browser claims a
//! queued step and settles its outcome (`routes/agent_runs.rs`). This is the
//! other half. When the lifecycle scanner finds a web-login policy due, the
//! rotation responder hands the job here, and the runner:
//!
//! 1. checks what a run needs and parks the job with the honest reason when
//!    something is missing ([`prepare`]) — an owner to drive it, a recipe the
//!    trust ladder lets it replay, a hook policy it can read;
//! 2. opens an observation run, so the owner's browser can claim its steps;
//! 3. drives `run_change_password_hooked` over an `ExtensionTransport` whose
//!    [`StepChannel`](opensesame_rotation_web::StepChannel) is the step
//!    queue ([`channel`]), with the organization's own
//!    `OpenSesameInterceptor` registered on the hook session and every
//!    interception record persisted before the next step reaches the driver;
//! 4. records how the run ended on the rotation job, closes the run, and
//!    reports the outcome to the scanner.
//!
//! # The credential boundary is unchanged
//!
//! Nothing here holds a password. A fill step carries a *reference* —
//! `current_password`, or a candidate's handle — and the driver resolves it
//! in the vault it holds; the candidate is generated, sealed and promoted in
//! that same vault ([`custody`]). No route, record or job detail carries a
//! value, and no method of the tool boundary returns one.
//!
//! # Approvals
//!
//! A tool rule that escalates is lifted only by the §9 approval seam. Until
//! the Interaction-backed approver lands, the launcher is built with
//! `approval_resolver: None`, so every escalation stays a denial — the
//! conformant reading of an unresolved approval (§9). The one place a
//! resolver plugs in is [`WebLoginLauncher::new`].

pub(crate) mod channel;
pub(crate) mod custody;
mod launch;
pub(crate) mod prepare;
pub(crate) mod records;
mod settle;

use std::sync::Arc;
use std::time::Duration;

use opensesame_agent_hooks::sdk::ApprovalResolver;

use crate::app_state::AppState;

#[cfg(test)]
pub(crate) use launch::Harness;

/// Builds the §9 approval seam for one run. A resolver is consumed by the
/// session it is registered on, so the launcher holds a factory.
pub(crate) type ApprovalResolverFactory = Arc<dyn Fn() -> Box<dyn ApprovalResolver> + Send + Sync>;

/// How long a run and each of its steps may take.
#[derive(Clone, Copy, Debug)]
pub(crate) struct RunTiming {
    /// Longest wait for one step's outcome. A driver that goes quiet is a
    /// driver that stopped, and the run parks rather than assume it landed.
    pub step_deadline: Duration,
    /// How often an unsettled step is looked at again. The queue is a table,
    /// and a settle may land on another gateway process, so a wait is a poll.
    pub poll: Duration,
    /// Longest a whole run may take. The policy lease outlives it, so a
    /// second process can never start the same rotation while this one runs.
    pub run_deadline: Duration,
}

impl Default for RunTiming {
    fn default() -> Self {
        Self {
            step_deadline: Duration::from_secs(
                u64::try_from(opensesame_storage::STEP_CLAIM_SECONDS).unwrap_or(120),
            ),
            poll: Duration::from_millis(250),
            run_deadline: Duration::from_secs(15 * 60),
        }
    }
}

/// Margin the policy lease keeps beyond the run deadline, for the settle
/// and release that follow the last step.
const LEASE_MARGIN_SECONDS: i64 = 120;

impl RunTiming {
    /// The policy lease a run of this length needs.
    pub(crate) fn lease_seconds(self) -> i64 {
        i64::try_from(self.run_deadline.as_secs())
            .unwrap_or(i64::MAX / 2)
            .saturating_add(LEASE_MARGIN_SECONDS)
    }
}

/// Starts and settles web-login runs.
pub(crate) struct WebLoginLauncher {
    state: AppState,
    approval_resolver: Option<ApprovalResolverFactory>,
    timing: RunTiming,
}

impl WebLoginLauncher {
    /// A launcher over `state`.
    ///
    /// `approval_resolver` is the §9 approval seam every run's hook session
    /// registers. `None` leaves every escalation a denial.
    pub(crate) fn new(state: AppState, approval_resolver: Option<ApprovalResolverFactory>) -> Self {
        Self {
            state,
            approval_resolver,
            timing: RunTiming::default(),
        }
    }

    /// Replace the run's clock (tests drive a fake extension quickly).
    #[cfg(test)]
    #[must_use]
    pub(crate) const fn with_timing(mut self, timing: RunTiming) -> Self {
        self.timing = timing;
        self
    }
}
