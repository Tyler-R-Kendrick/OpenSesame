//! What changed between two readings of a cohort.
//!
//! Three questions an operator actually asks, and the reason this is a type
//! rather than two set operations at a call site:
//!
//! - **"If I re-take this snapshot, who gains access?"** [`CohortDiff::added`],
//!   and [`CohortDiff::widens`] as the one-line answer. Re-taking a snapshot for
//!   a cohort whose whole purpose is not widening is the moment to be told it
//!   would.
//! - **"I removed them from the team — did that end their eligibility?"** If they
//!   are not in [`CohortDiff::removed`], it did not, and
//!   [`CohortDiff::rerouted`] shows the route that kept them. This is the mistake
//!   nesting makes easy and the one this module is really for: eligibility
//!   surviving a removal is invisible in a membership list and obvious in a diff.
//! - **"Did anything change at all?"** [`CohortDiff::is_empty`], so a re-take that
//!   changes nothing can say so instead of asking somebody to compare two rosters
//!   by eye.
//!
//! A diff is only ever taken between two readings of the *same* cohort, and only
//! from rosters whose digests verify. Both are refusals rather than conventions: a
//! diff across two cohorts is a meaningless list of everybody, and a diff computed
//! from a roster that failed its digest is worse than no diff at all, because it
//! invites somebody to act on a change that never happened.

use crate::{
    CohortId, CohortResolution, CohortSnapshot, DomainError, Eligibility, EligibilityPath,
    PrincipalId, Roster,
};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// How one principal's eligibility moved without starting or ending.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RouteChange {
    pub before: Eligibility,
    pub after: Eligibility,
}

impl RouteChange {
    /// Whether the canonical route itself changed — the principal is eligible for
    /// a different reason than before.
    #[must_use]
    pub fn path_changed(&self) -> bool {
        self.before.path != self.after.path
    }

    /// Whether the number of *other* routes admitting this principal changed.
    ///
    /// Not a change in access, but a change in how hard it is to end: going from
    /// one route to two means a removal that used to work no longer does.
    #[must_use]
    pub fn admissions_changed(&self) -> bool {
        self.before.additional_admissions != self.after.additional_admissions
    }

    /// Whether the principal became harder to remove.
    #[must_use]
    pub fn became_harder_to_revoke(&self) -> bool {
        self.after.additional_admissions > self.before.additional_admissions
    }
}

/// The difference between two readings of one cohort.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct CohortDiff {
    pub cohort_id: Option<CohortId>,
    /// Eligible after, not before, with the route that admits them now.
    pub added: BTreeMap<PrincipalId, EligibilityPath>,
    /// Eligible before, not after, with the route that used to admit them.
    pub removed: BTreeMap<PrincipalId, EligibilityPath>,
    /// Eligible in both, by a different route or a different number of routes.
    pub rerouted: BTreeMap<PrincipalId, RouteChange>,
}

impl CohortDiff {
    /// Diff two snapshots of the same cohort.
    ///
    /// # Errors
    ///
    /// [`DomainError::CohortSnapshotCohortMismatch`] when they are snapshots of
    /// different cohorts, or [`DomainError::CohortSnapshotDigestMismatch`] when
    /// either roster fails its digest.
    pub fn between_snapshots(
        before: &CohortSnapshot,
        after: &CohortSnapshot,
    ) -> Result<Self, DomainError> {
        if before.cohort_id != after.cohort_id {
            return Err(DomainError::CohortSnapshotCohortMismatch);
        }
        before.verify_digest()?;
        after.verify_digest()?;
        Ok(Self::diff(before.cohort_id, &before.roster, &after.roster))
    }

    /// Diff a stored snapshot against a fresh resolution of the live graph.
    ///
    /// The drift readout: what a snapshot cohort is holding back, and exactly what
    /// re-taking it would change. A snapshot cohort's revocation runbook ends with
    /// this call.
    ///
    /// # Errors
    ///
    /// As [`CohortDiff::between_snapshots`], for the snapshot side.
    pub fn since_snapshot(
        before: &CohortSnapshot,
        after: &CohortResolution,
    ) -> Result<Self, DomainError> {
        if before.cohort_id != after.cohort_id {
            return Err(DomainError::CohortSnapshotCohortMismatch);
        }
        before.verify_digest()?;
        Ok(Self::diff(before.cohort_id, &before.roster, &after.roster))
    }

    /// Diff two resolutions of the same cohort.
    ///
    /// # Errors
    ///
    /// [`DomainError::CohortSnapshotCohortMismatch`] when the two resolutions are
    /// of different cohorts.
    pub fn between_resolutions(
        before: &CohortResolution,
        after: &CohortResolution,
    ) -> Result<Self, DomainError> {
        if before.cohort_id != after.cohort_id {
            return Err(DomainError::CohortSnapshotCohortMismatch);
        }
        Ok(Self::diff(before.cohort_id, &before.roster, &after.roster))
    }

    fn diff(cohort_id: CohortId, before: &Roster, after: &Roster) -> Self {
        let mut added = BTreeMap::new();
        let mut removed = BTreeMap::new();
        let mut rerouted = BTreeMap::new();

        for (principal_id, now) in after {
            match before.get(principal_id) {
                None => {
                    added.insert(*principal_id, now.path.clone());
                }
                Some(then) if then != now => {
                    rerouted.insert(
                        *principal_id,
                        RouteChange {
                            before: then.clone(),
                            after: now.clone(),
                        },
                    );
                }
                Some(_) => {}
            }
        }
        for (principal_id, then) in before {
            if !after.contains_key(principal_id) {
                removed.insert(*principal_id, then.path.clone());
            }
        }

        Self {
            cohort_id: Some(cohort_id),
            added,
            removed,
            rerouted,
        }
    }

    /// Whether the two readings agree about everything.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.added.is_empty() && self.removed.is_empty() && self.rerouted.is_empty()
    }

    /// Whether anybody gained eligibility. The question to put in front of an
    /// operator before a snapshot is re-taken.
    #[must_use]
    pub fn widens(&self) -> bool {
        !self.added.is_empty()
    }

    /// Whether anybody lost eligibility.
    #[must_use]
    pub fn narrows(&self) -> bool {
        !self.removed.is_empty()
    }

    /// Principals who are eligible in both readings but became harder to remove.
    ///
    /// Worth its own accessor because it is invisible in `added` and `removed` —
    /// nothing about their access changed, only the number of things that would
    /// have to change to end it.
    #[must_use]
    pub fn harder_to_revoke(&self) -> Vec<PrincipalId> {
        self.rerouted
            .iter()
            .filter(|(_, change)| change.became_harder_to_revoke())
            .map(|(principal_id, _)| *principal_id)
            .collect()
    }
}
