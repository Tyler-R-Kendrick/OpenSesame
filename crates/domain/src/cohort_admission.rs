//! What a cohort's membership is read *from*: a frozen snapshot, or the live
//! graph.
//!
//! Both are legitimate and they are not interchangeable, so the choice is a
//! declared property of the cohort ([`AdmissionMode`]) and this module's job is
//! to hold every activation to whatever the cohort declared.
//!
//! **Snapshot.** The roster is taken once, digest-bound, and stored. Whoever was
//! eligible then stays eligible; somebody added to a nested team afterwards does
//! not reach this cohort. That is what you want for authority that must not widen
//! under an operator's feet — a break-glass group, a release-approver set — and
//! the cost is honest: a *removal* also does not take effect until a new snapshot
//! is taken, so a snapshot cohort needs a re-take in its revocation runbook.
//!
//! **Live.** The roster is resolved at the moment of activation. Somebody added
//! to the rotation can act, somebody removed cannot, with nothing to re-take.
//! The cost is that the answer moves, so it has to actually be *now*: a
//! resolution older than [`MAX_LIVE_RESOLUTION_AGE`] is refused. Without that
//! bound "live" degrades into "whatever was cached", which is the failure this
//! module exists to make impossible — a stale live check is strictly worse than a
//! snapshot, because nobody wrote down when it was taken or agreed to it.
//!
//! ## What is not here
//!
//! There is no credential in this module. A snapshot is a list of principals and
//! the routes that admitted them; a basis is a digest and a timestamp. Nothing a
//! member could hold, present, or pass to a non-member — see
//! [`CohortActivation`](crate::CohortActivation) for why the binding has to be
//! per-principal instead.

use crate::{
    roster_digest, AdmissionMode, Cohort, CohortId, CohortResolution, CohortSnapshotId,
    DomainError, Eligibility, PrincipalId, Roster,
};
use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};

/// How old a live resolution may be and still admit anybody.
///
/// A minute. The host that resolves a cohort is the host that mints the
/// activation from it, so this is not a network budget — it is the window in
/// which a membership change has not yet been noticed. Short enough that
/// "removed from the rotation" means removed; long enough to survive a slow
/// directory read without failing an authorization outright.
pub const MAX_LIVE_RESOLUTION_AGE: Duration = Duration::minutes(1);

impl AdmissionMode {
    /// The serialized name, for a message a human will read.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Live => "live",
            Self::Snapshot => "snapshot",
        }
    }
}

/// A cohort's membership, frozen and digest-bound.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct CohortSnapshot {
    pub id: CohortSnapshotId,
    pub cohort_id: CohortId,
    pub taken_at: DateTime<Utc>,
    /// Who was eligible, with the route that admitted each of them. The routes
    /// are kept rather than flattened to a list of principals: a snapshot that
    /// says who but not why cannot be reviewed a month later, and a diff against
    /// it could not tell a re-routed eligibility from an unchanged one.
    pub roster: Roster,
    /// Digest over the roster, as [`roster_digest`] computes it.
    pub roster_digest: String,
    /// Set when this snapshot was superseded or withdrawn.
    pub closed_at: Option<DateTime<Utc>>,
}

impl CohortSnapshot {
    /// Freeze a resolution.
    ///
    /// Takes a whole [`CohortResolution`] rather than a bare roster so the
    /// snapshot cannot be assembled from a roster somebody built by hand: every
    /// stored snapshot is the output of a validated, bounded traversal.
    ///
    /// A snapshot may be taken of a cohort in either mode — recording what a live
    /// cohort looked like at a moment is useful evidence. What it may not do is
    /// *admit* anybody to a live cohort; [`AdmissionBasis::assert_usable`] is
    /// where that is refused.
    ///
    /// # Errors
    ///
    /// [`DomainError::Canonicalization`] if the roster cannot be digested.
    pub fn take(id: CohortSnapshotId, resolution: &CohortResolution) -> Result<Self, DomainError> {
        Ok(Self {
            id,
            cohort_id: resolution.cohort_id,
            taken_at: resolution.resolved_at,
            roster: resolution.roster.clone(),
            roster_digest: resolution.roster_digest()?,
            closed_at: None,
        })
    }

    /// Recompute the digest and compare.
    ///
    /// This is what makes a stored roster tamper-evident, and it is checked on
    /// every snapshot-based admission rather than only when the row is loaded:
    /// adding a principal to the stored roster changes the digest, so a row
    /// edited underneath the host admits nobody instead of admitting the
    /// attacker.
    ///
    /// # Errors
    ///
    /// [`DomainError::CohortSnapshotDigestMismatch`] when the stored digest does
    /// not match the roster it is stored beside, or
    /// [`DomainError::Canonicalization`] if the roster cannot be digested at all.
    pub fn verify_digest(&self) -> Result<(), DomainError> {
        let recomputed = roster_digest(self.cohort_id, &self.roster)?;
        if recomputed != self.roster_digest {
            return Err(DomainError::CohortSnapshotDigestMismatch);
        }
        Ok(())
    }

    /// Withdraw or supersede this snapshot. Idempotent in effect: the first
    /// closing time is kept, because when it stopped counting is a fact about
    /// the past.
    #[must_use]
    pub fn close(self, closed_at: DateTime<Utc>) -> Self {
        if self.closed_at.is_some() {
            return self;
        }
        Self {
            closed_at: Some(closed_at),
            ..self
        }
    }

    /// Whether this snapshot may still admit anybody.
    ///
    /// Notice there is no expiry. A snapshot is frozen on purpose and does not
    /// rot on a timer — it stops counting when an operator closes it, which is
    /// the same act as taking its replacement. What bounds the *access* is the
    /// activation's own short lifetime, not the snapshot's age.
    ///
    /// # Errors
    ///
    /// [`DomainError::CohortSnapshotClosed`] once closed,
    /// [`DomainError::CohortSnapshotDigestMismatch`] if the roster no longer
    /// matches its digest, or [`DomainError::Canonicalization`].
    pub fn assert_usable(&self) -> Result<(), DomainError> {
        if let Some(closed_at) = self.closed_at {
            return Err(DomainError::CohortSnapshotClosed(format!(
                "closed at {closed_at}"
            )));
        }
        self.verify_digest()
    }

    /// Whether this snapshot makes `principal_id` eligible, and why.
    #[must_use]
    pub fn eligibility(&self, principal_id: PrincipalId) -> Option<&Eligibility> {
        self.roster.get(&principal_id)
    }
}

/// The membership an activation is about to be minted against.
///
/// Borrowed rather than owned, and an enum rather than two functions, so the one
/// check that matters — does this basis match what the cohort declared — happens
/// in one place no caller can skip.
#[derive(Clone, Copy, Debug)]
pub enum AdmissionBasis<'a> {
    /// A resolution of the live graph, which must be recent.
    Live(&'a CohortResolution),
    /// A frozen roster, which must be open and match its digest.
    Snapshot(&'a CohortSnapshot),
}

impl AdmissionBasis<'_> {
    #[must_use]
    pub fn mode(&self) -> AdmissionMode {
        match self {
            Self::Live(_) => AdmissionMode::Live,
            Self::Snapshot(_) => AdmissionMode::Snapshot,
        }
    }

    #[must_use]
    pub fn cohort_id(&self) -> CohortId {
        match self {
            Self::Live(resolution) => resolution.cohort_id,
            Self::Snapshot(snapshot) => snapshot.cohort_id,
        }
    }

    /// Whether this basis makes `principal_id` eligible, and why.
    #[must_use]
    pub fn eligibility(&self, principal_id: PrincipalId) -> Option<&Eligibility> {
        match self {
            Self::Live(resolution) => resolution.eligibility(principal_id),
            Self::Snapshot(snapshot) => snapshot.eligibility(principal_id),
        }
    }

    /// Whether this basis may admit anybody to `cohort`, right now.
    ///
    /// Three refusals, and each one is a mistake somebody makes:
    ///
    /// - a basis for a *different cohort* — the roster loaded for one group being
    ///   used to admit into another;
    /// - a basis in the *wrong mode* — a snapshot presented to a live cohort
    ///   (which would freeze a group whose whole point is that it moves) or a
    ///   live resolution presented to a snapshot cohort (which would widen a
    ///   group whose whole point is that it does not);
    /// - a *stale* live resolution — the cached-lookup failure described in the
    ///   module note.
    ///
    /// # Errors
    ///
    /// [`DomainError::CohortSnapshotCohortMismatch`],
    /// [`DomainError::CohortAdmissionModeMismatch`],
    /// [`DomainError::CohortResolutionStale`], or anything
    /// [`CohortSnapshot::assert_usable`] raises.
    pub fn assert_usable(&self, cohort: &Cohort, now: DateTime<Utc>) -> Result<(), DomainError> {
        if self.cohort_id() != cohort.id {
            return Err(DomainError::CohortSnapshotCohortMismatch);
        }
        if self.mode() != cohort.admission {
            return Err(DomainError::CohortAdmissionModeMismatch(format!(
                "{} declares {} admission; the basis offered is {}",
                cohort.id,
                cohort.admission.as_str(),
                self.mode().as_str()
            )));
        }
        match self {
            Self::Live(resolution) => {
                if resolution.resolved_at > now {
                    return Err(DomainError::CohortResolutionStale(format!(
                        "resolved at {} which is ahead of {now}",
                        resolution.resolved_at
                    )));
                }
                let age = now - resolution.resolved_at;
                if age > MAX_LIVE_RESOLUTION_AGE {
                    return Err(DomainError::CohortResolutionStale(format!(
                        "resolved {} seconds ago; live admission allows {}",
                        age.num_seconds(),
                        MAX_LIVE_RESOLUTION_AGE.num_seconds()
                    )));
                }
                Ok(())
            }
            Self::Snapshot(snapshot) => snapshot.assert_usable(),
        }
    }

    /// The owned record of this basis, to be kept with the activation.
    ///
    /// # Errors
    ///
    /// [`DomainError::Canonicalization`] if a live roster cannot be digested.
    pub fn record(&self) -> Result<AdmissionRecord, DomainError> {
        match self {
            Self::Live(resolution) => Ok(AdmissionRecord::Live {
                resolved_at: resolution.resolved_at,
                roster_digest: resolution.roster_digest()?,
            }),
            Self::Snapshot(snapshot) => Ok(AdmissionRecord::Snapshot {
                snapshot_id: snapshot.id,
                roster_digest: snapshot.roster_digest.clone(),
            }),
        }
    }
}

/// What an activation remembers about the membership it was minted from.
///
/// Kept with the activation and therefore in the receipt: months later, "why was
/// Dana allowed to do this" is answerable from the record — which snapshot, or
/// which live reading at which instant, and the digest that pins the roster
/// either way. Without it an activation is an assertion; with it, it is evidence.
///
/// The serialized tags and field names are persisted. Do not rename them.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "kind")]
pub enum AdmissionRecord {
    Live {
        resolved_at: DateTime<Utc>,
        roster_digest: String,
    },
    Snapshot {
        snapshot_id: CohortSnapshotId,
        roster_digest: String,
    },
}

impl AdmissionRecord {
    #[must_use]
    pub fn mode(&self) -> AdmissionMode {
        match self {
            Self::Live { .. } => AdmissionMode::Live,
            Self::Snapshot { .. } => AdmissionMode::Snapshot,
        }
    }

    /// The roster digest this activation was minted against.
    #[must_use]
    pub fn roster_digest(&self) -> &str {
        match self {
            Self::Live { roster_digest, .. } | Self::Snapshot { roster_digest, .. } => {
                roster_digest
            }
        }
    }
}
