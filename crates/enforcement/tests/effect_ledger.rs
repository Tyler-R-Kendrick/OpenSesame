//! Desired and observed, kept apart, per grant.
//!
//! The bug every case here guards against is the same one: writing what
//! authority asked for into the field a reader treats as what happened. On a
//! surface where enforcement is a call that can fail — or a boundary nothing
//! reports on — those are different facts, and the ledger refuses to blur
//! them even when that leaves a dimension permanently unresolved.

use opensesame_enforcement::descriptor::{AdapterStatus, EnforcementDescriptor};
use opensesame_enforcement::dimension::Dimension;
use opensesame_enforcement::effect::{
    Desired, Divergence, FailureCode, Observed, Reconciliation, Report, ReportRefused,
};
use opensesame_enforcement::guarantee::{
    Bypass, Guarantee, Latency, Mechanism, Observability, Survival,
};
use opensesame_enforcement::ledger::{EffectLedger, LedgerReportRefused};
use opensesame_enforcement::ownership::{EnforcementPoint, SubjectSurface};
use opensesame_enforcement::preflight::preflight;
use opensesame_enforcement::requirement::{Requirement, Requirements};

/// A supervised sandbox: the lease is re-read on every call, termination
/// travels to the kernel and is reported back, and the sandbox itself is a
/// boundary nothing reports on.
fn sandbox() -> EnforcementDescriptor {
    EnforcementDescriptor::builder(
        "test-sandbox",
        SubjectSurface::SupervisedSandbox,
        AdapterStatus::Implemented {
            module: "crates/enforcement/tests",
        },
    )
    .enforced(
        Dimension::Expiry,
        Guarantee::new(
            Mechanism::BrokerLeaseExpiry,
            EnforcementPoint::HostBroker,
            Bypass::DistinctAuthority,
            Latency::WithinSeconds(30),
            Survival::ProcessRestart,
            Observability::Reported,
        ),
    )
    .enforced(
        Dimension::Termination,
        Guarantee::new(
            Mechanism::ProcessTermination,
            EnforcementPoint::OsKernel,
            Bypass::DistinctAuthority,
            Latency::WithinSeconds(5),
            Survival::DeviceReboot,
            Observability::Reported,
        ),
    )
    .enforced(
        Dimension::Isolation,
        Guarantee::new(
            Mechanism::OsSandbox,
            EnforcementPoint::OsKernel,
            Bypass::LocalPrivilegeEscalation,
            Latency::WithinSeconds(1),
            Survival::DeviceReboot,
            Observability::Unobservable,
        ),
    )
    .build()
    .expect("a consistent supervised-sandbox descriptor")
}

fn all_three() -> Requirements {
    Dimension::ALL
        .into_iter()
        .fold(Requirements::none(), |requirements, dimension| {
            requirements.require(Requirement::independent(dimension))
        })
}

fn open_ledger(now_seconds: u64) -> EffectLedger {
    let descriptor = sandbox();
    preflight(&all_three(), &descriptor)
        .expect("the sandbox holds all three")
        .open_ledger(now_seconds)
}

#[test]
fn an_admission_opens_every_entry_unreported() {
    // Admission says the platform *can*. It is not a report that it did, and
    // this is the assertion that keeps the two apart at the moment they are
    // most likely to be conflated.
    let ledger = open_ledger(0);
    assert_eq!(ledger.entries().len(), 3);
    for effect in ledger.entries() {
        assert_eq!(effect.desired(), Desired::InForce);
        assert_eq!(effect.observed(), Observed::Unreported);
        assert_eq!(effect.observed_at(), None);
    }
    assert!(
        !ledger.all_converged(0),
        "nothing has reported, so nothing has converged"
    );
}

#[test]
fn awaiting_is_neither_converged_nor_diverged() {
    // The state a caller must not read as either. "No divergences" is not
    // "settled", and treating it as such reports success while nothing has
    // reported at all.
    let ledger = open_ledger(0);
    let termination = ledger
        .effect(Dimension::Termination)
        .expect("termination is tracked");
    assert_eq!(
        termination.reconcile(3),
        Reconciliation::Awaiting {
            for_seconds: 3,
            budget_seconds: Some(5),
        }
    );
    assert!(!ledger.all_converged(3));
}

#[test]
fn a_budget_that_runs_out_with_nothing_reported_is_a_fault() {
    let ledger = open_ledger(0);
    let termination = ledger
        .effect(Dimension::Termination)
        .expect("termination is tracked");
    assert_eq!(
        termination.reconcile(6),
        Reconciliation::Diverged(Divergence::Overdue {
            for_seconds: 6,
            budget_seconds: 5,
        }),
        "something was supposed to report and did not"
    );
    let diverged: Vec<Dimension> = ledger
        .divergences(6)
        .into_iter()
        .map(|(dimension, _)| dimension)
        .collect();
    assert!(diverged.contains(&Dimension::Termination));
}

#[test]
fn a_dimension_nothing_reports_on_never_converges_and_says_so() {
    // The honest end state. Silence on an unobservable boundary is not
    // agreement, and no amount of waiting turns it into agreement.
    let ledger = open_ledger(0);
    let isolation = ledger
        .effect(Dimension::Isolation)
        .expect("isolation is tracked");
    for now in [0, 1, 2, 86_400] {
        assert_eq!(
            isolation.reconcile(now),
            Reconciliation::Diverged(Divergence::Unverifiable),
            "at {now}s"
        );
    }
}

#[test]
fn nothing_can_be_recorded_against_an_unobservable_dimension() {
    // Including a report from the kernel that really does hold the sandbox:
    // the guarantee says nothing reports, so a report arriving for it is
    // somebody's inference wearing the kernel's name.
    let mut ledger = open_ledger(0);
    let refused = ledger
        .observe(
            Dimension::Isolation,
            Report::holding(EnforcementPoint::OsKernel),
            1,
        )
        .expect_err("nothing reports on the sandbox");
    assert_eq!(
        refused,
        LedgerReportRefused::Refused(ReportRefused::NothingReports {
            dimension: Dimension::Isolation,
            observability: Observability::Unobservable,
        })
    );
}

#[test]
fn a_subject_cannot_witness_its_own_containment() {
    let mut ledger = open_ledger(0);
    for from in [
        EnforcementPoint::SubjectItself,
        EnforcementPoint::SubjectRuntime,
    ] {
        let refused = ledger
            .observe(Dimension::Termination, Report::holding(from), 1)
            .expect_err("the subject is the thing under examination");
        assert_eq!(
            refused,
            LedgerReportRefused::Refused(ReportRefused::NotIndependentOfSubject { from })
        );
    }
}

#[test]
fn a_report_from_a_point_that_does_not_enforce_it_is_not_recorded() {
    // A provider saying the sandbox is up is not evidence about the sandbox.
    let mut ledger = open_ledger(0);
    let refused = ledger
        .observe(
            Dimension::Termination,
            Report::holding(EnforcementPoint::Provider),
            1,
        )
        .expect_err("the kernel enforces this one");
    assert_eq!(
        refused,
        LedgerReportRefused::Refused(ReportRefused::FromAnotherPoint {
            dimension: Dimension::Termination,
            from: EnforcementPoint::Provider,
            enforced_by: EnforcementPoint::OsKernel,
        })
    );
}

#[test]
fn the_absence_of_a_report_cannot_be_submitted_as_one() {
    let mut ledger = open_ledger(0);
    let refused = ledger
        .observe(
            Dimension::Termination,
            Report {
                from: EnforcementPoint::OsKernel,
                observed: Observed::Unreported,
            },
            1,
        )
        .expect_err("`unreported` is the opening state, not a statement");
    assert_eq!(
        refused,
        LedgerReportRefused::Refused(ReportRefused::NotAnObservation)
    );
}

#[test]
fn an_observation_from_the_enforcing_point_converges() {
    let mut ledger = open_ledger(0);
    ledger
        .observe(
            Dimension::Termination,
            Report::holding(EnforcementPoint::OsKernel),
            4,
        )
        .expect("the kernel reports on the process group it holds");
    let termination = ledger
        .effect(Dimension::Termination)
        .expect("termination is tracked");
    assert_eq!(termination.observed(), Observed::Holding);
    assert_eq!(termination.observed_at(), Some(4));
    assert_eq!(termination.reconcile(4), Reconciliation::Converged);
}

#[test]
fn a_new_demand_clears_the_old_observation() {
    // A report that the lease was holding is not a report that it was pulled.
    // Carrying it over would show the new demand as already satisfied — the
    // stale green tick this whole module exists to prevent.
    let mut ledger = open_ledger(0);
    ledger
        .observe(
            Dimension::Termination,
            Report::holding(EnforcementPoint::OsKernel),
            4,
        )
        .expect("recorded");
    ledger
        .desire(Dimension::Termination, Desired::Lifted, 10)
        .expect("authority may pull it");
    let termination = ledger
        .effect(Dimension::Termination)
        .expect("termination is tracked");
    assert_eq!(termination.desired(), Desired::Lifted);
    assert_eq!(
        termination.observed(),
        Observed::Unreported,
        "the stale observation is cleared, not carried forward"
    );
    assert_eq!(
        termination.reconcile(12),
        Reconciliation::Awaiting {
            for_seconds: 2,
            budget_seconds: Some(5),
        },
        "the budget runs from the new demand"
    );
    ledger
        .observe(
            Dimension::Termination,
            Report::lifted(EnforcementPoint::OsKernel),
            13,
        )
        .expect("the kernel reports the group is gone");
    assert_eq!(
        ledger
            .effect(Dimension::Termination)
            .expect("tracked")
            .reconcile(13),
        Reconciliation::Converged
    );
}

#[test]
fn a_point_reporting_the_opposite_of_the_demand_diverges() {
    let mut ledger = open_ledger(0);
    ledger
        .observe(
            Dimension::Termination,
            Report::lifted(EnforcementPoint::OsKernel),
            2,
        )
        .expect("recorded");
    assert_eq!(
        ledger
            .effect(Dimension::Termination)
            .expect("tracked")
            .reconcile(2),
        Reconciliation::Diverged(Divergence::Contradicted {
            desired: Desired::InForce,
            observed: Observed::Lifted,
        })
    );
}

#[test]
fn an_enforcement_point_that_could_not_comply_diverges_with_its_reason() {
    let mut ledger = open_ledger(0);
    ledger
        .observe(
            Dimension::Termination,
            Report::failed(EnforcementPoint::OsKernel, FailureCode::PointRefused),
            2,
        )
        .expect("a failure is a report like any other");
    // Two seconds in, the three axes are in three different states, and the
    // ledger reports each as itself: a failure with its code, a boundary
    // nothing can confirm, and a lease still inside its budget.
    assert_eq!(
        ledger.divergences(2),
        vec![
            (
                Dimension::Termination,
                Divergence::Failed {
                    code: FailureCode::PointRefused
                }
            ),
            (Dimension::Isolation, Divergence::Unverifiable),
        ]
    );
    assert_eq!(
        ledger
            .effect(Dimension::Expiry)
            .expect("tracked")
            .reconcile(2),
        Reconciliation::Awaiting {
            for_seconds: 2,
            budget_seconds: Some(30),
        }
    );
}

#[test]
fn the_ledger_tracks_only_what_the_grant_demanded() {
    // A deployment cannot revoke a constraint it never asked for, and a
    // caller that thinks it can has a bug worth surfacing.
    let descriptor = sandbox();
    let requirements = Requirements::none().require(Requirement::independent(Dimension::Expiry));
    let mut ledger = preflight(&requirements, &descriptor)
        .expect("expiry alone is held")
        .open_ledger(0);
    assert_eq!(ledger.entries().len(), 1);
    assert!(ledger.effect(Dimension::Isolation).is_none());
    let refused = ledger
        .observe(
            Dimension::Isolation,
            Report::holding(EnforcementPoint::OsKernel),
            1,
        )
        .expect_err("isolation was never demanded");
    assert!(matches!(refused, LedgerReportRefused::NotTracked(_)));
    assert!(ledger
        .desire(Dimension::Termination, Desired::Lifted, 1)
        .is_err());
}
