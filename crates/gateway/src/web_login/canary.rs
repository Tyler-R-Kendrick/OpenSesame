//! What a run proved about the recipe it replayed (ADR 0076 §4: "the candidate
//! is canary-verified … and subsequent runs on that domain drop to
//! deterministic T3").
//!
//! A canary is a real change at the real site, confirmed by a fresh login —
//! exactly what a completed run is. So the Host records it itself, against
//! the very document the run replayed (its digest): a completed run makes a
//! verified recipe canary-verified, and a run that found the page no longer
//! matched the recipe, or submitted a change it could not confirm, demotes it
//! until a person proves it again. A run that stopped before submitting for
//! any other reason (a challenge, a person taking the page, a refused step, a
//! quiet transport) proves nothing about the recipe and changes nothing.
//!
//! The record is the Host's, never a request's: no route takes a canary
//! result, so the only ways one reaches a row are a signer's attestation
//! inside a verified signature and this.

use chrono::Utc;
use opensesame_connection_broker::rotation::web_login::WebLoginSettlement;
use opensesame_rotation_web::hooks::HostedRunError;
use opensesame_rotation_web::{BlockedReason, ExecutorError, RunOutcome, RunReport};
use opensesame_storage::web_login_runs::recipes::RunResult;
use opensesame_storage::Db;

use super::prepare::Plan;

/// Whether the executor stopped because the page did not match the recipe.
pub(crate) fn drifted(report: &Result<RunReport, HostedRunError<ExecutorError>>) -> bool {
    matches!(
        report,
        Ok(RunReport {
            outcome: RunOutcome::Blocked(BlockedReason::RecipeDrift),
            ..
        })
    )
}

/// What a settlement proves about the recipe, if anything.
pub(crate) fn proof_of(settlement: &WebLoginSettlement, drifted: bool) -> Option<RunResult> {
    match settlement {
        WebLoginSettlement::Completed => Some(RunResult::Passed),
        WebLoginSettlement::Reconcile(_) => Some(RunResult::Failed),
        WebLoginSettlement::NotSubmitted(_) => drifted.then_some(RunResult::Failed),
    }
}

/// Record what `settlement` proved about the recipe `plan` replayed. A store
/// that cannot be written is logged and goes on: the run's own settlement
/// stands, and a canary that was not recorded only means the next unattended
/// run asks for an attended one first.
pub(crate) async fn record(
    db: &Db,
    plan: &Plan,
    settlement: &WebLoginSettlement,
    drifted: bool,
    run_id: &str,
) {
    let Some(result) = proof_of(settlement, drifted) else {
        return;
    };
    let recorded = db
        .record_web_login_recipe_run(
            &plan.organization_id.to_string(),
            &plan.origin,
            &plan.recipe_digest,
            result,
            run_id,
            &Utc::now().to_rfc3339(),
        )
        .await;
    if let Err(error) = recorded {
        tracing::error!(%error, run_id, "a web-login run's canary could not be recorded");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_what_the_recipe_is_responsible_for_is_recorded() {
        let blocked = WebLoginSettlement::NotSubmitted("a person took the page".into());
        let reconcile = WebLoginSettlement::Reconcile("unconfirmed".into());
        assert_eq!(
            proof_of(&WebLoginSettlement::Completed, false),
            Some(RunResult::Passed)
        );
        assert_eq!(proof_of(&reconcile, false), Some(RunResult::Failed));
        assert_eq!(proof_of(&blocked, true), Some(RunResult::Failed), "drift");
        assert_eq!(proof_of(&blocked, false), None, "a stop that is not drift");
        // Drift cannot turn a completed run into a failure.
        assert_eq!(
            proof_of(&WebLoginSettlement::Completed, true),
            Some(RunResult::Passed)
        );
    }

    #[test]
    fn drift_is_the_executors_own_word_for_it() {
        let report = |outcome| {
            Ok(RunReport {
                outcome,
                steps: Vec::new(),
                lease: opensesame_session_observe::ControlLease::new(),
            })
        };
        assert!(drifted(&report(RunOutcome::Blocked(
            BlockedReason::RecipeDrift
        ))));
        assert!(!drifted(&report(RunOutcome::Blocked(
            BlockedReason::Challenge
        ))));
        assert!(!drifted(&report(RunOutcome::Completed)));
    }
}
