//! Desired and observed, kept apart.
//!
//! Authority asking is not the platform doing. The gap between the two is
//! where an authorization system quietly becomes fiction: "revoked" in a
//! console usually means *we asked*, and whether anything stopped is a
//! separate question that on some surfaces nothing can answer.
//!
//! So an [`Effect`] holds two states — a [`Desired`] that only authority
//! writes and an [`Observed`] that only an enforcement point's [`Report`]
//! writes — and there is no method that copies one into the other.
//! [`Effect::reconcile`] compares them and says what it sees; it never
//! promotes a wish into an observation.
//!
//! Three properties are load-bearing:
//!
//! - **A dimension nothing can observe diverges rather than converging.** An
//!   [`Observability::Unobservable`] guarantee reconciles to
//!   [`Divergence::Unverifiable`] forever. The tempting bug is to treat "no
//!   contradicting report" as agreement, which would make the least
//!   accountable platform look like the most settled one.
//! - **A report from the subject is refused, not recorded.** Reports are
//!   admitted only from the enforcement point the guarantee actually named,
//!   and only when that point is
//!   [independent of the subject](crate::ownership::EnforcementPoint::independent_of_subject).
//!   A subject attesting to its own containment is the thing being checked.
//! - **A new demand clears the old observation.** [`Effect::desire`] resets
//!   [`Observed::Unreported`] when what authority wants changes, because a
//!   report that the sandbox was holding is not a report that it was torn
//!   down.
//!
//! The crate reads no clock. Every entry point takes `now_seconds` on whatever
//! monotonic scale the caller reconciles against, so the caller's clock stays
//! the caller's and a test can walk a budget without sleeping.

use crate::dimension::Dimension;
use crate::guarantee::{Guarantee, Observability};
use crate::ownership::EnforcementPoint;
use serde::{Deserialize, Serialize};
use thiserror::Error;

/// What authority wants of a dimension. Only authority writes this.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Desired {
    /// The guarantee should be holding the subject.
    InForce,
    /// Authority has asked for it to stop — the grant is finished, the lease
    /// pulled, the sandbox torn down.
    Lifted,
}

/// Why an enforcement point could not do what was asked.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FailureCode {
    /// The point could not be reached to be told.
    PointUnreachable,
    /// The point was reached and declined.
    PointRefused,
    /// The mechanism is not available on this host right now — a sandbox the
    /// kernel will not build, a lease store that is gone.
    MechanismUnavailable,
    /// The point has no record of what it is being asked about.
    SubjectUnknown,
}

impl FailureCode {
    /// The wire name.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::PointUnreachable => "point_unreachable",
            Self::PointRefused => "point_refused",
            Self::MechanismUnavailable => "mechanism_unavailable",
            Self::SubjectUnknown => "subject_unknown",
        }
    }
}

/// What an enforcement point has said. Only a [`Report`] writes this.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "observed", rename_all = "snake_case")]
pub enum Observed {
    /// Nothing has reported. The opening state, and not a statement about the
    /// world.
    Unreported,
    /// The point reports the guarantee is holding.
    Holding,
    /// The point reports the guarantee is no longer holding.
    Lifted,
    /// The point reports it could not do what was asked.
    Failed {
        /// Why.
        code: FailureCode,
    },
}

/// One enforcement point's statement about one dimension.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Report {
    /// The component reporting. Checked against the guarantee's own
    /// enforcement point: a report is admissible from the thing that does the
    /// enforcing, and from nothing else.
    pub from: EnforcementPoint,
    /// What it says.
    pub observed: Observed,
}

impl Report {
    /// The point reports the guarantee is holding.
    #[must_use]
    pub const fn holding(from: EnforcementPoint) -> Self {
        Self {
            from,
            observed: Observed::Holding,
        }
    }

    /// The point reports the guarantee is no longer holding.
    #[must_use]
    pub const fn lifted(from: EnforcementPoint) -> Self {
        Self {
            from,
            observed: Observed::Lifted,
        }
    }

    /// The point reports it could not comply.
    #[must_use]
    pub const fn failed(from: EnforcementPoint, code: FailureCode) -> Self {
        Self {
            from,
            observed: Observed::Failed { code },
        }
    }
}

/// Why a report was not recorded.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Error, Serialize, Deserialize)]
#[serde(tag = "report_refused", rename_all = "snake_case")]
pub enum ReportRefused {
    /// The reporter is the subject, or lives inside it. A subject attesting to
    /// its own containment is the thing under examination.
    #[error("`{}` is not independent of the subject, so its report is not evidence", from.as_str())]
    NotIndependentOfSubject {
        /// The reporter.
        from: EnforcementPoint,
    },
    /// The reporter is not the component this guarantee says enforces it.
    #[error(
        "the `{}` dimension is enforced by `{}`, not by `{}`",
        dimension.as_str(),
        enforced_by.as_str(),
        from.as_str()
    )]
    FromAnotherPoint {
        /// The axis.
        dimension: Dimension,
        /// Who reported.
        from: EnforcementPoint,
        /// Who would have to.
        enforced_by: EnforcementPoint,
    },
    /// The guarantee says nothing reports on this dimension, so a report
    /// arriving for it is somebody's inference wearing the point's name.
    #[error(
        "nothing reports on the `{}` dimension, so there is nothing to record",
        dimension.as_str()
    )]
    NothingReports {
        /// The axis.
        dimension: Dimension,
        /// What the guarantee actually offers.
        observability: Observability,
    },
    /// [`Observed::Unreported`] is the absence of a report, not one.
    #[error("`unreported` is the absence of a report, not a report")]
    NotAnObservation,
}

/// Where a dimension stands once desired and observed are compared.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "reconciliation", rename_all = "snake_case")]
pub enum Reconciliation {
    /// The point reported what authority wanted.
    Converged,
    /// Nothing has reported and the guarantee's latency budget has not run
    /// out. Neither converged nor diverged — the state a caller must not read
    /// as either.
    Awaiting {
        /// How long the current demand has stood.
        for_seconds: u64,
        /// The guarantee's budget, where it states one.
        budget_seconds: Option<u32>,
    },
    /// It cannot be reconciled.
    Diverged(Divergence),
}

/// Why a dimension cannot be reconciled.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "divergence", rename_all = "snake_case")]
pub enum Divergence {
    /// Nothing reports on this dimension, so no amount of waiting will
    /// confirm it. Said out loud rather than allowed to look settled.
    Unverifiable,
    /// The budget ran out and the point that reports never did.
    Overdue {
        /// How long the demand has stood.
        for_seconds: u64,
        /// The budget it outlived.
        budget_seconds: u32,
    },
    /// The point reported the opposite of what authority wants.
    Contradicted {
        /// What authority wants.
        desired: Desired,
        /// What the point says.
        observed: Observed,
    },
    /// The point reported it could not comply.
    Failed {
        /// Why.
        code: FailureCode,
    },
}

/// One dimension's desired and observed state.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Effect {
    dimension: Dimension,
    guarantee: Guarantee,
    desired: Desired,
    desired_since: u64,
    observed: Observed,
    observed_at: Option<u64>,
}

impl Effect {
    /// Open an entry: authority wants the guarantee in force, and nothing has
    /// reported. Admission is a statement about what the platform can do, never
    /// a report that it has.
    #[must_use]
    pub const fn opening(dimension: Dimension, guarantee: Guarantee, now_seconds: u64) -> Self {
        Self {
            dimension,
            guarantee,
            desired: Desired::InForce,
            desired_since: now_seconds,
            observed: Observed::Unreported,
            observed_at: None,
        }
    }

    /// State what authority now wants.
    ///
    /// A change clears the observation: a report that the lease was holding is
    /// not a report that it was pulled, and carrying it over would show the new
    /// demand as already satisfied.
    pub fn desire(&mut self, desired: Desired, now_seconds: u64) {
        if self.desired == desired {
            return;
        }
        self.desired = desired;
        self.desired_since = now_seconds;
        self.observed = Observed::Unreported;
        self.observed_at = None;
    }

    /// Record an enforcement point's report.
    ///
    /// # Errors
    ///
    /// [`ReportRefused`] when the reporter is inside the subject, is not the
    /// point this guarantee names, when the guarantee says nothing reports at
    /// all, or when the report is [`Observed::Unreported`].
    pub fn observe(&mut self, report: Report, now_seconds: u64) -> Result<(), ReportRefused> {
        if matches!(report.observed, Observed::Unreported) {
            return Err(ReportRefused::NotAnObservation);
        }
        if matches!(self.guarantee.observability, Observability::Unobservable) {
            return Err(ReportRefused::NothingReports {
                dimension: self.dimension,
                observability: self.guarantee.observability,
            });
        }
        if !report.from.independent_of_subject() {
            return Err(ReportRefused::NotIndependentOfSubject { from: report.from });
        }
        if report.from != self.guarantee.point {
            return Err(ReportRefused::FromAnotherPoint {
                dimension: self.dimension,
                from: report.from,
                enforced_by: self.guarantee.point,
            });
        }
        self.observed = report.observed;
        self.observed_at = Some(now_seconds);
        Ok(())
    }

    /// Compare what authority wants against what has been reported.
    #[must_use]
    pub fn reconcile(&self, now_seconds: u64) -> Reconciliation {
        match self.observed {
            Observed::Failed { code } => Reconciliation::Diverged(Divergence::Failed { code }),
            Observed::Holding | Observed::Lifted => self.reconcile_reported(self.observed),
            Observed::Unreported => self.reconcile_silence(now_seconds),
        }
    }

    fn reconcile_reported(&self, observed: Observed) -> Reconciliation {
        let agrees = matches!(
            (self.desired, observed),
            (Desired::InForce, Observed::Holding) | (Desired::Lifted, Observed::Lifted)
        );
        if agrees {
            Reconciliation::Converged
        } else {
            Reconciliation::Diverged(Divergence::Contradicted {
                desired: self.desired,
                observed,
            })
        }
    }

    fn reconcile_silence(&self, now_seconds: u64) -> Reconciliation {
        // Nothing will ever report, so waiting cannot resolve this and
        // silence must not be read as agreement.
        if matches!(self.guarantee.observability, Observability::Unobservable) {
            return Reconciliation::Diverged(Divergence::Unverifiable);
        }
        let for_seconds = now_seconds.saturating_sub(self.desired_since);
        let Some(budget_seconds) = self.guarantee.latency.budget_seconds() else {
            // An unbounded latency states no deadline, so it has none to miss.
            return Reconciliation::Awaiting {
                for_seconds,
                budget_seconds: None,
            };
        };
        if for_seconds <= u64::from(budget_seconds) {
            return Reconciliation::Awaiting {
                for_seconds,
                budget_seconds: Some(budget_seconds),
            };
        }
        match self.guarantee.observability {
            // Something was supposed to report and did not. That is a fault in
            // the enforcement path, not a missed deadline.
            Observability::Reported => Reconciliation::Diverged(Divergence::Overdue {
                for_seconds,
                budget_seconds,
            }),
            // An inferred mechanism never claimed it would report. The budget
            // passing is the whole of the evidence it was ever going to offer,
            // which is exactly what `Inferred` means.
            Observability::Inferred | Observability::Unobservable => Reconciliation::Converged,
        }
    }

    /// The axis.
    #[must_use]
    pub const fn dimension(&self) -> Dimension {
        self.dimension
    }

    /// The guarantee relied on, so a receipt can name it rather than asserting
    /// that something was enforced.
    #[must_use]
    pub const fn guarantee(&self) -> Guarantee {
        self.guarantee
    }

    /// What authority wants.
    #[must_use]
    pub const fn desired(&self) -> Desired {
        self.desired
    }

    /// When the current demand was made.
    #[must_use]
    pub const fn desired_since(&self) -> u64 {
        self.desired_since
    }

    /// What has been reported.
    #[must_use]
    pub const fn observed(&self) -> Observed {
        self.observed
    }

    /// When it was reported, if it has been.
    #[must_use]
    pub const fn observed_at(&self) -> Option<u64> {
        self.observed_at
    }
}
