//! The Host's web-login runner: the executor side of the step channel, run as
//! an agent-hooks/0.1 session (ADR 0076, ADR 0081, ADR 0159).
//!
//! The gateway already served the *driver's* half — a browser claims a
//! queued step and settles its outcome (`routes/agent_runs.rs`). This is the
//! other half. When the lifecycle scanner finds a web-login policy due, it
//! [`start`]s a tracked task ([`registry`]) and moves on — a run takes minutes,
//! and the scanner is one loop over every tenant. The task claims the policy,
//! and the runner:
//!
//! 1. checks what a run needs and parks the job with the honest reason when
//!    something is missing ([`prepare`]) — an owner to drive it, a recipe the
//!    trust ladder lets it replay, a hook policy it can read;
//! 2. opens an observation run, so the owner's browser can claim its steps;
//! 3. drives `run_change_password_hooked` over an `ExtensionTransport` whose
//!    [`StepChannel`](opensesame_rotation_web::StepChannel) is the step
//!    queue ([`channel`]), with the organization's own
//!    `OpenSesameInterceptor` registered on the hook session and every
//!    interception record persisted before the next step reaches the driver.
//!    Before each step the channel consults the run's persisted control state
//!    ([`control`]): a person who asked for the page parks the run at a safe
//!    point, and nothing is enqueued while a person holds it;
//! 4. records how the run ended on the rotation job, closes the run (unless a
//!    person has it), and publishes the outcome itself, on the `agent.*` and
//!    lifecycle feeds.
//!
//! What a stopped process leaves half-run is closed by [`reaper`], and what
//! ages out is trimmed by [`crate::retention`].
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
//! A tool rule that escalates is lifted only by the §9 approval seam. Each
//! run builds its own: a `BoundApprovalResolver` over an `InteractionApprover`
//! that asks the person the organization named (`agent_hook_approvers`), or
//! else the operator's default, through the Identity API the deployment
//! configured ([`crate::agent_hook_approver`]). A deployment that configured
//! none, an organization that names nobody, or anything unreadable on the way
//! leaves the run with no resolver, and every escalation stays a denial — the
//! conformant reading of an unresolved approval (§9). The run's hook session
//! registers `redact_for_approver` as its approval redactor, so what a person
//! is shown, and what their proof binds to, held no credential shape.
//!
//! The one place a resolver is chosen is [`WebLoginLauncher::resolver_for`],
//! which both the lifecycle responder and the scanner's tracked runs reach
//! through [`WebLoginLauncher::from_state`].

#[cfg(test)]
mod approver_tests;
mod attended;
mod canary;
pub(crate) mod channel;
#[cfg(test)]
mod claim_tests;
mod close;
#[cfg(test)]
mod close_tests;
pub(crate) mod control;
pub(crate) mod custody;
#[cfg(test)]
mod custody_hooks_tests;
#[cfg(test)]
mod deadline_tests;
#[cfg(test)]
mod handoff_tests;
#[cfg(test)]
mod held_tests;
#[cfg(test)]
mod identity_mock;
mod launch;
pub(crate) mod prepare;
pub(crate) mod reaper;
#[cfg(test)]
mod reaper_tests;
#[cfg(test)]
pub(crate) mod recipe_fixture;
#[cfg(test)]
mod recipe_gate_tests;
pub(crate) mod recipe_trust;
pub(crate) mod records;
pub(crate) mod registry;
mod settle;
#[cfg(test)]
mod stand_down_tests;
mod start;
#[cfg(test)]
mod start_tests;
#[cfg(test)]
mod test_support;

use std::sync::Arc;
use std::time::Duration;

use opensesame_agent_hooks::sdk::ApprovalResolver;

use crate::app_state::AppState;

#[cfg(test)]
pub(crate) use launch::Harness;
pub(crate) use start::{run_held, start, start_attended};

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
    close_retry: close::CloseRetry,
    /// Every context each run's hook session emits, as a test saw it.
    #[cfg(test)]
    tap: Option<test_support::Tap>,
}

impl WebLoginLauncher {
    /// A launcher over `state`.
    ///
    /// `approval_resolver`, when given, is the §9 approval seam every run's
    /// hook session registers, whatever the deployment configured (tests
    /// script one). `None` builds each run's seam from the deployment's
    /// approver configuration and the organization's approver, if there are
    /// both; with neither, every escalation stays a denial.
    pub(crate) fn new(state: AppState, approval_resolver: Option<ApprovalResolverFactory>) -> Self {
        Self {
            state,
            approval_resolver,
            timing: RunTiming::default(),
            close_retry: close::CloseRetry::default(),
            #[cfg(test)]
            tap: None,
        }
    }

    /// The launcher every production path builds: over `state`, with each
    /// run's approval seam built from the deployment's configuration, so the
    /// lifecycle responder and the scanner's tracked runs cannot disagree
    /// about it.
    pub(crate) fn from_state(state: &AppState) -> Self {
        Self::new(state.clone(), None)
    }

    /// The §9 approval seam for one run of `organization_id`'s, if anybody is
    /// to be asked.
    pub(crate) async fn resolver_for(
        &self,
        organization_id: &opensesame_domain::OrganizationId,
    ) -> Option<Box<dyn ApprovalResolver>> {
        match &self.approval_resolver {
            Some(factory) => Some(factory()),
            None => crate::agent_hook_approver::resolver_for(&self.state, organization_id).await,
        }
    }

    /// Replace the run's clock (tests drive a fake extension quickly).
    #[cfg(test)]
    #[must_use]
    pub(crate) const fn with_timing(mut self, timing: RunTiming) -> Self {
        self.timing = timing;
        self
    }

    /// Register, beside the organization's interceptor, one that records every
    /// context the run's session emits and allows it (tests read what the real
    /// launcher's session said, e.g. an `agent_shutdown`'s reason).
    #[cfg(test)]
    #[must_use]
    fn with_tap(mut self, tap: test_support::Tap) -> Self {
        self.tap = Some(tap);
        self
    }

    /// `interceptors`, plus the test tap when there is one.
    #[cfg(test)]
    fn tapped(
        &self,
        mut interceptors: Vec<Box<dyn opensesame_agent_hooks::sdk::Interceptor>>,
    ) -> Vec<Box<dyn opensesame_agent_hooks::sdk::Interceptor>> {
        interceptors.extend(self.tap.clone().map(|tap| Box::new(tap) as Box<_>));
        interceptors
    }

    /// Replace how hard a run is closed (tests make the retries instant).
    #[cfg(test)]
    #[must_use]
    pub(crate) const fn with_close_retry(mut self, retry: close::CloseRetry) -> Self {
        self.close_retry = retry;
        self
    }
}
