//! A whole run as one agent-hooks session: startup, the request in, the verbs,
//! the report out, shutdown.
//!
//! [`host_run`] is the lifecycle and nothing else, generic over what the run
//! does, so the two ordering executors and the CTK harness drive the same
//! emission path. It holds §3.1's order — `agent_startup`, `input`, the
//! run's verbs, `output`, `agent_shutdown` — and §6.1a's rule that a session
//! refused at startup processes nothing yet still emits its shutdown, with
//! reason `error`.
//!
//! The `input` is the run request, payload-free by construction: which kind of
//! run, which recipe, which origin. Never a credential, never a candidate — the
//! request names them no more than the tools do. The `output` is the run's
//! report: outcome and steps, or the sealed digests, which redeem nothing.

use std::future::Future;

use agent_hooks::InterceptionPoint;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use thiserror::Error;

use opensesame_session_observe::ControlLease;

use super::refusal::{InputRole, Refusal, ShutdownReason};
use super::session::HookSession;
use super::transport::{HookedTransport, BROWSER_VERBS, CEREMONY_VERBS};
use crate::ceremony::{
    run_capture_steps, CaptureError, CaptureReport, CaptureStep, CeremonyTransport,
};
use crate::executor::{
    run_change_password, BlockedReason, CandidateVault, ChangePasswordRecipe, ExecutorError,
    RunOutcome, RunReport,
};
use crate::tools::{BrowserTransport, CredentialRef, StepError};

/// What kind of run a request asks for.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RunKind {
    /// A web-login rotation (ADR 0076).
    ChangePassword,
    /// A registration ceremony's captures (ADR 0082).
    Capture,
}

/// The run request, as the `input` emission carries it.
///
/// Identifiers only. The recipe says which flow and the origin says which
/// site; the credential is a reference inside the recipe's steps, and the
/// candidate does not exist yet.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RunRequest {
    pub run: RunKind,
    /// The recipe's identifier.
    pub recipe: String,
    /// The target origin, e.g. `https://example.com`.
    pub origin: String,
}

impl RunRequest {
    /// `input.content`.
    #[must_use]
    pub fn content(&self) -> Value {
        json!({ "run": self.run, "recipe": self.recipe, "origin": self.origin })
    }
}

/// A report a run hands back, as the `output` emission carries it.
pub trait Reported: Sized {
    /// `output.content`: the report, payload-free.
    fn report(&self) -> Value;

    /// The report the caller receives when the effective content is `report`
    /// — after a transform — or `None` when it cannot be expressed. `None`
    /// is refused as `host_error:transform_invalid` and the report withheld.
    fn restate(self, report: Value) -> Option<Self>;

    /// `summary.reason` for a run that delivered this report.
    fn shutdown_reason(&self) -> ShutdownReason {
        ShutdownReason::Completed
    }
}

/// A run's report is a statement of fact about a third-party site — whether
/// its password changed, which captures are sealed — and the host acts on it
/// (promote the candidate, reconcile, re-ask for a slot). A transform that
/// rewrote it would have the host report a state it did not reach: a
/// `completed` rotation restated as `blocked` is the lockout ADR 0076 exists
/// to prevent. So, as with the run request at `input`, the only transform the
/// host can apply is one that leaves the report as it was; any other is
/// `host_error:transform_invalid` (§5.2) and the report is withheld.
fn unchanged<R: Reported>(report: R, restated: &Value) -> Option<R> {
    (report.report() == *restated).then_some(report)
}

impl Reported for RunReport {
    fn report(&self) -> Value {
        json!({ "outcome": self.outcome, "steps": self.steps })
    }

    fn restate(self, report: Value) -> Option<Self> {
        unchanged(self, &report)
    }

    fn shutdown_reason(&self) -> ShutdownReason {
        // The executor stood down because a person holds the page.
        if self.outcome == RunOutcome::Blocked(BlockedReason::HumanDriving) {
            ShutdownReason::Cancelled
        } else {
            ShutdownReason::Completed
        }
    }
}

impl Reported for CaptureReport {
    fn report(&self) -> Value {
        json!({ "sealed": self.sealed, "outstanding": self.outstanding })
    }

    fn restate(self, report: Value) -> Option<Self> {
        unchanged(self, &report)
    }
}

/// Why a hosted run returned no report.
///
/// The variants split on the one question a caller must not guess at: did
/// the run act? [`Refused`](Self::Refused) means it never began;
/// [`Withheld`](Self::Withheld) means it ran to its end and only the report
/// is missing, so whatever it did to the site — a submitted change, a sealed
/// capture — has to be reconciled, never assumed not to have happened.
#[derive(Clone, Debug, PartialEq, Eq, Error)]
pub enum HostedRunError<E> {
    /// A hook verdict refused the session at startup or the request at
    /// input: no verb ran (§6, §6.1a). The reason, never content.
    #[error("the run was refused: {0}")]
    Refused(Refusal),
    /// The run finished, and a hook verdict refused its report at `output`
    /// (§6: the response is not returned). The run's effects stand and are
    /// unknown to the caller — reconcile. The reason, never content.
    #[error("the run's report was withheld: {0}")]
    Withheld(Refusal),
    /// The run itself failed; the session closed with reason `error`.
    #[error("the run failed: {0}")]
    Run(E),
}

/// The `input` emission: who asked, and what.
#[derive(Clone, Debug, PartialEq)]
pub struct HostInput {
    /// `input.content`.
    pub content: Value,
    /// `input.role`.
    pub role: InputRole,
}

impl HookSession {
    /// Emit the `input` for a turn.
    ///
    /// The request is what the turn consumes, and this host cannot run a
    /// different recipe than the one it was handed: a transform that changes
    /// the request is refused as `host_error:transform_invalid`, never ignored.
    ///
    /// # Errors
    ///
    /// The [`Refusal`] when the turn must not begin (§6).
    pub async fn input(&self, input: &HostInput) -> Result<(), Refusal> {
        let expected = json!({ "content": input.content, "role": input.role.as_str() });
        self.emit(
            InterceptionPoint::Input,
            |builder| builder.input(input.content.clone(), input.role.as_str()),
            move |target| (target == expected).then_some(()),
        )
        .await
    }

    /// Emit the `output` for a turn and hand back the report the caller may
    /// receive — transformed, if the verdict transformed it.
    ///
    /// # Errors
    ///
    /// The [`Refusal`] when the report must not be returned (§6), including a
    /// transform the report cannot take ([`Reported::restate`]). What the run
    /// did is not undone; the report is withheld.
    pub async fn output<R: Reported>(&self, report: R) -> Result<R, Refusal> {
        let content = report.report();
        self.emit(
            InterceptionPoint::Output,
            |builder| builder.output(content),
            move |target| {
                let content = target.get("content").cloned()?;
                report.restate(content)
            },
        )
        .await
    }
}

/// Run `run` as one agent-hooks session with `tools` registered.
///
/// # Errors
///
/// [`HostedRunError::Refused`] when a verdict blocks the session or the
/// request (nothing ran), [`HostedRunError::Withheld`] when it blocks the
/// report (the run ran), [`HostedRunError::Run`] when the run fails. The
/// session is shut down either way.
pub async fn host_run<R, E, F, Fut>(
    session: &HookSession,
    tools: &[&str],
    input: &HostInput,
    run: F,
) -> Result<R, HostedRunError<E>>
where
    R: Reported,
    F: FnOnce() -> Fut,
    Fut: Future<Output = Result<R, E>>,
{
    let admitted = match session.startup(tools).await {
        Ok(()) => session.input(input).await,
        Err(refusal) => Err(refusal),
    };
    if let Err(refusal) = admitted {
        session.shutdown(ShutdownReason::Error).await;
        return Err(HostedRunError::Refused(refusal));
    }
    let report = match run().await {
        Ok(report) => report,
        Err(error) => {
            session.shutdown(ShutdownReason::Error).await;
            return Err(HostedRunError::Run(error));
        }
    };
    let reason = report.shutdown_reason();
    match session.output(report).await {
        Ok(report) => {
            session.shutdown(reason).await;
            Ok(report)
        }
        Err(refusal) => {
            session.shutdown(ShutdownReason::Error).await;
            Err(HostedRunError::Withheld(refusal))
        }
    }
}

/// [`run_change_password`] as a hosted session over `hooked`'s verbs.
///
/// # Errors
///
/// As [`host_run`], with the executor's own [`ExecutorError`].
pub async fn run_change_password_hooked<T: BrowserTransport>(
    hooked: &HookedTransport<T>,
    vault: &dyn CandidateVault,
    recipe: &ChangePasswordRecipe,
    current: &CredentialRef,
    lease: ControlLease,
    request: &RunRequest,
) -> Result<RunReport, HostedRunError<ExecutorError>> {
    let input = HostInput {
        content: request.content(),
        role: InputRole::System,
    };
    host_run(hooked.session(), &BROWSER_VERBS, &input, || {
        run_change_password(hooked, vault, recipe, current, lease)
    })
    .await
}

/// [`run_capture_steps`] as a hosted session over `hooked`'s verbs.
///
/// # Errors
///
/// As [`host_run`], with the first [`CaptureError`] a step produced; a
/// refused `outstanding()` read is [`StepError::Refused`] inside
/// [`CaptureError::Step`].
pub async fn run_capture_steps_hooked<T: CeremonyTransport>(
    hooked: &HookedTransport<T>,
    steps: &[CaptureStep],
    request: &RunRequest,
) -> Result<CaptureReport, HostedRunError<CaptureError>> {
    let input = HostInput {
        content: request.content(),
        role: InputRole::System,
    };
    let tools: Vec<&str> = BROWSER_VERBS
        .iter()
        .chain(&CEREMONY_VERBS)
        .copied()
        .collect();
    host_run(hooked.session(), &tools, &input, || async {
        let report = run_capture_steps(hooked, steps).await?;
        // `tool_seam_host_error: terminate`: a refused ledger read fails the
        // run like any refused capture. Its all-slots answer kept the
        // executor from reading the ceremony as finished; it is not a report.
        if hooked.ledger_refused() {
            return Err(CaptureError::Step(StepError::Refused));
        }
        Ok(report)
    })
    .await
}
