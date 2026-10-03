//! How a hosted run's result becomes the rotation job's settlement.
//!
//! The split the job records is the one a person needs first: did the site
//! receive a change? [`WebLoginSettlement::NotSubmitted`] says the previous
//! password still stands; [`WebLoginSettlement::Reconcile`] says it may not.
//!
//! - `HostedRunError::Refused` — a verdict refused the session or the request:
//!   nothing ran, so nothing was submitted.
//! - `HostedRunError::Withheld` — the run went to its end and only its report
//!   was refused, so whatever it did stands unknown: reconcile.
//! - `HostedRunError::Run` — the executor failed (a lease refusal can come
//!   after the submit), so reconcile.
//! - A report is read as the executor wrote it, with one refinement: a submit
//!   a hook refused at `pre_tool_call` was never handed to the driver, so the
//!   executor's "the site's state is unknown" is, in that one case, known.
//!
//! Every detail is fixed text plus a verdict's reason as a machine identifier
//! and its interception point — never a message, never content.

use opensesame_agent_hooks::sdk::InterceptionPoint;
use opensesame_connection_broker::rotation::web_login::WebLoginSettlement;
use opensesame_rotation_web::hooks::{HookedTransport, HostedRunError, Refusal};
use opensesame_rotation_web::{ActionStep, BlockedReason, ExecutorError, RunOutcome, RunReport};

use super::control::Stop;
use crate::agent_hooks::machine_reason;

/// `reason at point`, value-blind.
fn refusal_text(refusal: &Refusal) -> String {
    format!(
        "{} at {}",
        refusal
            .reason
            .as_deref()
            .map_or("no reason", machine_reason),
        refusal.point.as_str()
    )
}

/// The job's settlement for a hosted run's result.
pub(crate) async fn settlement_of<T>(
    report: Result<RunReport, HostedRunError<ExecutorError>>,
    hooked: &HookedTransport<T>,
    promoted: bool,
) -> WebLoginSettlement {
    let refusal = hooked.session().last_refusal().await;
    match report {
        Ok(report) => from_report(report, refusal.as_ref(), promoted),
        Err(HostedRunError::Refused(refusal)) => WebLoginSettlement::NotSubmitted(format!(
            "the run was refused before it began: {}",
            refusal_text(&refusal)
        )),
        Err(HostedRunError::Withheld(refusal)) => WebLoginSettlement::Reconcile(format!(
            "the run finished, but its report was withheld: {}",
            refusal_text(&refusal)
        )),
        Err(HostedRunError::Run(error)) => {
            WebLoginSettlement::Reconcile(format!("the run failed: {error}"))
        }
    }
}

fn from_report(report: RunReport, refusal: Option<&Refusal>, promoted: bool) -> WebLoginSettlement {
    let refused = |detail: &str| match refusal {
        Some(refusal) => format!("{detail} ({})", refusal_text(refusal)),
        None => detail.to_owned(),
    };
    match report.outcome {
        RunOutcome::Completed if promoted => WebLoginSettlement::Completed,
        RunOutcome::Completed => WebLoginSettlement::Reconcile(
            "the change was verified, but the vault did not acknowledge promoting it".into(),
        ),
        RunOutcome::Blocked(reason) => {
            WebLoginSettlement::NotSubmitted(if reason == BlockedReason::HookRefused {
                refused(reason.detail())
            } else {
                reason.detail().to_owned()
            })
        }
        RunOutcome::ReconciliationRequired(_)
            if !report.steps.contains(&ActionStep::Submitted)
                && refusal.is_some_and(|r| r.point == InterceptionPoint::PreToolCall) =>
        {
            // Every earlier refusal blocks the run before it reaches the
            // submit, so the refusal on record is the submit's own, made
            // before the step was ever enqueued.
            WebLoginSettlement::NotSubmitted(refused("a hook verdict refused the submit"))
        }
        RunOutcome::ReconciliationRequired(detail) => {
            WebLoginSettlement::Reconcile(refused(&detail))
        }
    }
}

/// A settlement for a run a person stopped: they asked for the page and it
/// parked for them, or it was already theirs. Whether the site received a
/// change is exactly what the executor's report said — this only adds why the
/// run ended, so the job never reads as a fault in the runner.
pub(crate) fn handed_over(settlement: WebLoginSettlement, stop: Stop) -> WebLoginSettlement {
    let note = match stop {
        Stop::HandedOff => "the run parked at a safe point for the person who asked for the page",
        Stop::PersonHasIt => "a person holds the page, so the run sent nothing more",
        Stop::Gone => return settlement,
    };
    match settlement {
        WebLoginSettlement::Completed => WebLoginSettlement::Completed,
        WebLoginSettlement::NotSubmitted(detail) => {
            WebLoginSettlement::NotSubmitted(format!("{detail}; {note}"))
        }
        WebLoginSettlement::Reconcile(detail) => {
            WebLoginSettlement::Reconcile(format!("{detail}; {note}"))
        }
    }
}

/// A settlement for a run that ran past its deadline — waiting, say, on an
/// approval nobody answered. It is stopped where it stands, so what the site
/// received is known only by whether a submit ever went out.
pub(crate) fn overdue(submit_sent: bool) -> WebLoginSettlement {
    const DETAIL: &str = "the run ran past its deadline and was stopped";
    if submit_sent {
        WebLoginSettlement::Reconcile(format!(
            "{DETAIL}; a submit had been sent, so the site may have taken the change"
        ))
    } else {
        WebLoginSettlement::NotSubmitted(DETAIL.into())
    }
}

/// A settlement whose run's hook records could not all be written. A
/// completed change is still a change, but one nobody can audit is not
/// reported as a clean success.
pub(crate) fn unaudited(settlement: WebLoginSettlement) -> WebLoginSettlement {
    const NOTE: &str = "its hook records could not all be persisted";
    match settlement {
        WebLoginSettlement::Completed => {
            WebLoginSettlement::Reconcile(format!("the change completed, but {NOTE}"))
        }
        WebLoginSettlement::NotSubmitted(detail) => {
            WebLoginSettlement::NotSubmitted(format!("{detail}; {NOTE}"))
        }
        WebLoginSettlement::Reconcile(detail) => {
            WebLoginSettlement::Reconcile(format!("{detail}; {NOTE}"))
        }
    }
}

/// A settlement for a run that could not be closed. Whatever the run reached,
/// the job is parked for reconciliation rather than settled as final: the run
/// is still open, so a driver's late answer to a step it still holds may yet
/// be stored, and a person has to look. What is known about the site is kept.
pub(crate) fn unclosed(settlement: WebLoginSettlement) -> WebLoginSettlement {
    const NOTE: &str = "the run could not be closed, so its steps may still take an answer \
         until it is reaped";
    WebLoginSettlement::Reconcile(match settlement {
        WebLoginSettlement::Completed => format!("the change completed, but {NOTE}"),
        WebLoginSettlement::NotSubmitted(detail) => {
            format!("not submitted ({detail}), but {NOTE}")
        }
        WebLoginSettlement::Reconcile(detail) => format!("{detail}; {NOTE}"),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use opensesame_session_observe::ControlLease;

    fn report(outcome: RunOutcome, steps: Vec<ActionStep>) -> RunReport {
        RunReport {
            outcome,
            steps,
            lease: ControlLease::new(),
        }
    }

    fn refusal(point: InterceptionPoint, reason: &str) -> Refusal {
        Refusal {
            point,
            reason: Some(reason.into()),
        }
    }

    #[test]
    fn a_refused_submit_was_never_sent() {
        let unknown = RunOutcome::ReconciliationRequired("unknown".into());
        let pre = refusal(InterceptionPoint::PreToolCall, "opensesame:tool_denied");
        let settled = from_report(report(unknown.clone(), vec![]), Some(&pre), false);
        assert_eq!(
            settled,
            WebLoginSettlement::NotSubmitted(
                "a hook verdict refused the submit (opensesame:tool_denied at pre_tool_call)"
                    .into()
            )
        );
        // Refused after it ran: the site may have taken it.
        let post = refusal(InterceptionPoint::PostToolCall, "opensesame:tool_denied");
        assert!(matches!(
            from_report(report(unknown.clone(), vec![]), Some(&post), false),
            WebLoginSettlement::Reconcile(_)
        ));
        // A transport failure with no refusal is unknown too.
        assert!(matches!(
            from_report(report(unknown, vec![]), None, false),
            WebLoginSettlement::Reconcile(_)
        ));
    }

    #[test]
    fn a_completion_needs_the_vault_to_promote() {
        let done = || report(RunOutcome::Completed, vec![ActionStep::Promoted]);
        assert_eq!(
            from_report(done(), None, true),
            WebLoginSettlement::Completed
        );
        assert!(matches!(
            from_report(done(), None, false),
            WebLoginSettlement::Reconcile(_)
        ));
        assert!(matches!(
            unaudited(WebLoginSettlement::Completed),
            WebLoginSettlement::Reconcile(_)
        ));
    }

    #[test]
    fn a_run_that_could_not_be_closed_parks_whatever_it_reached() {
        for reached in [
            WebLoginSettlement::Completed,
            WebLoginSettlement::NotSubmitted("a hook refused".into()),
            WebLoginSettlement::Reconcile("the site may have it".into()),
        ] {
            let known = match &reached {
                WebLoginSettlement::Completed => "the change completed".to_owned(),
                WebLoginSettlement::NotSubmitted(d) | WebLoginSettlement::Reconcile(d) => d.clone(),
            };
            let WebLoginSettlement::Reconcile(detail) = unclosed(reached) else {
                panic!("an unclosed run is a reconciliation");
            };
            assert!(detail.contains(&known), "what was known is kept: {detail}");
            assert!(detail.contains("could not be closed"), "{detail}");
        }
    }

    #[test]
    fn a_prose_reason_never_reaches_a_detail() {
        let secret = format!("ghp_{}", "x".repeat(36));
        let prose = refusal(InterceptionPoint::PreToolCall, &format!("saw {secret}"));
        let blocked = report(RunOutcome::Blocked(BlockedReason::HookRefused), vec![]);
        let WebLoginSettlement::NotSubmitted(detail) = from_report(blocked, Some(&prose), false)
        else {
            panic!("a block is not a submit");
        };
        assert!(!detail.contains(&secret), "{detail}");
        assert!(detail.contains("opensesame:reason_withheld"), "{detail}");
    }
}
