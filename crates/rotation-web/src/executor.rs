use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use thiserror::Error;

use opensesame_session_observe::{ControlLease, ControlState, CriticalExit};

use crate::tools::{BrowserTransport, CandidateHandle, CredentialRef, Filled, Presence, Verified};

/// Where a web-login run ended up.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RunOutcome {
    /// The site accepted the change and a fresh login proved it.
    Completed,
    /// Stopped before anything was submitted. The previous password still
    /// works, which is the sentence a person needs first.
    Blocked(BlockedReason),
    /// Submitted, and we cannot say what happened. The previous value is
    /// retained and a person reconciles (ADR 0076 constraint 5).
    ReconciliationRequired(String),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BlockedReason {
    /// The relying party asked for something a person has to answer.
    Challenge,
    /// The page did not match what the recipe expects.
    RecipeDrift,
    /// The candidate was not durably backed up, so submitting could strand it.
    BackupNotAcknowledged,
    /// The field did not hold the candidate at submit time.
    CandidateAbsent,
    /// A person took the page and has not given it back.
    HumanDriving,
    /// The runner could not act.
    Transport,
}

impl BlockedReason {
    /// The value-blind hint carried on the `agent.*` feed and the parked job.
    #[must_use]
    pub const fn detail(self) -> &'static str {
        match self {
            Self::Challenge => "the site asked for a step-up or a challenge",
            Self::RecipeDrift => "the change-password page did not match the recipe",
            Self::BackupNotAcknowledged => "the new password was not durably backed up",
            Self::CandidateAbsent => "the password field did not hold the new value",
            Self::HumanDriving => "a person is driving this run",
            Self::Transport => "the sandbox runner could not act",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Error)]
pub enum ExecutorError {
    #[error("the control lease refused the transition: {0}")]
    Lease(String),
    #[error("the recipe names no {0}")]
    IncompleteRecipe(&'static str),
}

/// The selectors one change-password flow needs.
///
/// A recipe, reduced to what the executor uses. Every target the run may touch
/// is named here, so a step cannot name a node the recipe did not declare
/// (ADR 0076: "Recipe pins the target").
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChangePasswordRecipe {
    pub change_url: String,
    pub current_password_selector: Option<String>,
    pub new_password_selector: String,
    pub confirm_password_selector: Option<String>,
    pub submit_selector: String,
}

/// Everything the executor needs that is not the browser.
///
/// `seal_and_await_backup` is a function rather than a flag because ADR 0076
/// constraint 2 is about *waiting on an acknowledgement*, not about having
/// asked: the outbox is what makes "durably written" something the code can
/// wait on rather than assume.
#[async_trait]
pub trait CandidateVault: Send + Sync {
    /// Generate a candidate and return its handle. The value never leaves.
    async fn generate_candidate(&self) -> Result<CandidateHandle, BlockedReason>;

    /// Seal the candidate and wait for the backup outbox to acknowledge it.
    ///
    /// Returns whether the acknowledgement arrived. `false` blocks the run
    /// before anything is submitted, because a candidate lost after the site
    /// accepted it is an unrecoverable lockout.
    async fn seal_and_await_backup(&self, candidate: &CandidateHandle) -> bool;

    /// Promote the candidate to the live credential, after verification.
    async fn promote(&self, candidate: &CandidateHandle);
}

/// What the executor did, in order, so a caller can record it on the action
/// lane and a test can assert the ordering.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ActionStep {
    Navigated,
    GeneratedCandidate,
    SealedAndBackedUp,
    FilledCurrent,
    FilledCandidate,
    FilledConfirmation,
    EnteredCriticalSection,
    AssertedCandidatePresent,
    Submitted,
    LeftCriticalSection,
    VerifiedByFreshLogin,
    Promoted,
}

/// One completed run: what happened, and the steps it took to get there.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RunReport {
    pub outcome: RunOutcome,
    pub steps: Vec<ActionStep>,
    pub lease: ControlLease,
}

/// Run one web-login rotation.
///
/// The ordering below is `docs/architecture/web-login-rotation.md`'s "ordering
/// that must not be rearranged", and two edges in it are the difference between
/// a rotation and a lockout:
///
/// - **Backup acknowledgement before submit.** A candidate lost after the site
///   accepted it is unrecoverable, so the run blocks rather than submits.
/// - **A fail-closed presence assertion immediately before submit, inside a
///   critical section.** The forbidden implementation is
///   fill-if-you-can-then-submit-anyway; that is how a password silently
///   becomes a placeholder. The critical section is what stops a handoff
///   landing between the assertion and the submit and voiding it.
///
/// # Errors
///
/// [`ExecutorError`] when the recipe is incomplete or the lease refuses a
/// transition the run needs. A *failed rotation* is not an error — it is a
/// [`RunOutcome`], because a caller has to record it either way.
pub async fn run_change_password(
    browser: &dyn BrowserTransport,
    vault: &dyn CandidateVault,
    recipe: &ChangePasswordRecipe,
    current: &CredentialRef,
    mut lease: ControlLease,
) -> Result<RunReport, ExecutorError> {
    let mut steps = Vec::new();

    // A run only drives while the agent holds the page. If a person took it,
    // the executor stands down rather than racing them.
    if lease.state() != ControlState::AgentDriving {
        return Ok(RunReport {
            outcome: RunOutcome::Blocked(BlockedReason::HumanDriving),
            steps,
            lease,
        });
    }

    if browser.navigate(&recipe.change_url).await.is_err() {
        return Ok(blocked(BlockedReason::Transport, steps, lease));
    }
    if browser
        .wait_for(&recipe.new_password_selector)
        .await
        .is_err()
    {
        return Ok(blocked(BlockedReason::RecipeDrift, steps, lease));
    }
    steps.push(ActionStep::Navigated);

    let candidate = match vault.generate_candidate().await {
        Ok(candidate) => candidate,
        Err(reason) => return Ok(blocked(reason, steps, lease)),
    };
    steps.push(ActionStep::GeneratedCandidate);

    // Before anything is typed into the site: seal it, and wait to be told it
    // is durably written.
    if !vault.seal_and_await_backup(&candidate).await {
        return Ok(blocked(BlockedReason::BackupNotAcknowledged, steps, lease));
    }
    steps.push(ActionStep::SealedAndBackedUp);

    let reference = candidate.as_credential_ref();
    if let Err(reason) = fill_fields(browser, recipe, current, &reference, &mut steps).await {
        return Ok(blocked(reason, steps, lease));
    }

    // —— the span nothing may interrupt ————————————————————————————
    lease
        .enter_critical()
        .map_err(|error| ExecutorError::Lease(error.to_string()))?;
    steps.push(ActionStep::EnteredCriticalSection);

    let presence = browser
        .assert_present(&reference, &recipe.new_password_selector)
        .await;
    match presence {
        Ok(Presence::Present) => steps.push(ActionStep::AssertedCandidatePresent),
        Ok(Presence::Absent | Presence::Mismatch) => {
            // Suspending inside the section is allowed and clears it; the run
            // has typed nothing the site accepted, so the old password stands.
            lease
                .suspend()
                .map_err(|error| ExecutorError::Lease(error.to_string()))?;
            return Ok(blocked(BlockedReason::CandidateAbsent, steps, lease));
        }
        Err(error) => {
            lease
                .suspend()
                .map_err(|e| ExecutorError::Lease(e.to_string()))?;
            return Ok(blocked(step_block(&error), steps, lease));
        }
    }

    let submitted = browser.submit(&recipe.submit_selector).await;
    if submitted.is_ok() {
        steps.push(ActionStep::Submitted);
    }
    let exit = lease
        .leave_critical()
        .map_err(|error| ExecutorError::Lease(error.to_string()))?;
    steps.push(ActionStep::LeftCriticalSection);
    if submitted.is_err() {
        // The submit itself failed, so nothing was accepted and the old value
        // stands — but we cannot prove the site saw nothing, so this
        // reconciles rather than reporting a clean block.
        return Ok(RunReport {
            outcome: RunOutcome::ReconciliationRequired(
                "the submit did not complete; the site's state is unknown".into(),
            ),
            steps,
            lease,
        });
    }
    // A handoff that arrived mid-submit is released now, not before.
    let _ = exit == CriticalExit::HandoffReleased;

    match browser.verify_login(&reference).await {
        Ok(Verified::Works) => {
            steps.push(ActionStep::VerifiedByFreshLogin);
            vault.promote(&candidate).await;
            steps.push(ActionStep::Promoted);
            Ok(RunReport {
                outcome: RunOutcome::Completed,
                steps,
                lease,
            })
        }
        // The site took the submit and the new value does not work. We do not
        // know which credential is live, and the previous one is retained.
        Ok(Verified::Rejected | Verified::Indeterminate) | Err(_) => Ok(RunReport {
            outcome: RunOutcome::ReconciliationRequired(
                "the change was submitted but a fresh login did not confirm it".into(),
            ),
            steps,
            lease,
        }),
    }
}

/// Type the current and candidate values into the fields the recipe declares.
///
/// Split out so [`run_change_password`] stays readable as the ordering it is —
/// the load-bearing part is the wait, the assertion and the submit, and three
/// near-identical fills between them obscure it. Every target is named by the
/// recipe: a step cannot fill a node the recipe did not declare.
async fn fill_fields(
    browser: &dyn BrowserTransport,
    recipe: &ChangePasswordRecipe,
    current: &CredentialRef,
    candidate: &CredentialRef,
    steps: &mut Vec<ActionStep>,
) -> Result<(), BlockedReason> {
    let fill = |reference: &'_ CredentialRef, selector: &'_ str, step: ActionStep| {
        let reference = reference.clone();
        let selector = selector.to_string();
        async move {
            match browser.fill_credential(&reference, &selector).await {
                Ok(Filled::Ok) => Ok(step),
                Ok(Filled::NoSuchField) => Err(BlockedReason::RecipeDrift),
                Err(error) => Err(step_block(&error)),
            }
        }
    };
    if let Some(selector) = &recipe.current_password_selector {
        steps.push(fill(current, selector, ActionStep::FilledCurrent).await?);
    }
    steps.push(
        fill(
            candidate,
            &recipe.new_password_selector,
            ActionStep::FilledCandidate,
        )
        .await?,
    );
    if let Some(selector) = &recipe.confirm_password_selector {
        steps.push(fill(candidate, selector, ActionStep::FilledConfirmation).await?);
    }
    Ok(())
}

fn blocked(reason: BlockedReason, steps: Vec<ActionStep>, lease: ControlLease) -> RunReport {
    RunReport {
        outcome: RunOutcome::Blocked(reason),
        steps,
        lease,
    }
}

const fn step_block(error: &crate::tools::StepError) -> BlockedReason {
    match error {
        crate::tools::StepError::Challenge => BlockedReason::Challenge,
        crate::tools::StepError::Timeout | crate::tools::StepError::NoSuchElement => {
            BlockedReason::RecipeDrift
        }
        crate::tools::StepError::Navigation | crate::tools::StepError::Transport => {
            BlockedReason::Transport
        }
    }
}
