//! Why a principal is eligible: the route through the graph that admitted them.
//!
//! A cohort that answers "yes" and cannot say why is unreviewable. Nesting is
//! exactly what makes the question hard — by the third level, "is Dana in the
//! reviewers?" has an answer nobody can derive by reading one row — so every
//! eligible principal carries the path that admitted them, and that path is
//! carried through snapshots, activations and diffs rather than being
//! recomputed for a screen.
//!
//! A path is an explanation, not a capability. It grants nothing, holds no
//! secret, and is safe to log and to show.

use crate::{CohortId, CohortMember, DomainError, PrincipalId, MAX_COHORT_DEPTH};
use serde::{Deserialize, Serialize};
use std::fmt;

/// The route from the cohort that was asked about to the row that admitted a
/// principal, rendered `cohort:root > cohort:leads > team:platform`.
///
/// The last hop is always a leaf — a direct principal or a team. A path ending
/// in a nested cohort would be an explanation that stops before the answer, and
/// [`EligibilityPath::new`] refuses it.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
pub struct EligibilityPath {
    /// The cohort the question was asked about.
    root: CohortId,
    /// Nested cohorts descended into, in order, excluding the root.
    hops: Vec<CohortId>,
    /// The row that actually admitted the principal.
    admitted_by: CohortMember,
}

impl EligibilityPath {
    /// Build a path, refusing one that cannot be an explanation.
    ///
    /// # Errors
    ///
    /// - [`DomainError::CohortPathInvalid`] when `admitted_by` names a nested
    ///   cohort rather than a leaf, or when a cohort appears twice — a path that
    ///   revisits a cohort is a loop, and a loop is not a route.
    /// - [`DomainError::CohortDepthExceeded`] past [`MAX_COHORT_DEPTH`].
    pub fn new(
        root: CohortId,
        hops: Vec<CohortId>,
        admitted_by: CohortMember,
    ) -> Result<Self, DomainError> {
        if !admitted_by.is_leaf() {
            return Err(DomainError::CohortPathInvalid(format!(
                "{admitted_by} is a nested cohort, so it explains nothing on its own"
            )));
        }
        let depth = hops.len() + 1;
        if depth > MAX_COHORT_DEPTH {
            return Err(DomainError::CohortDepthExceeded(depth));
        }
        let mut seen = vec![root];
        for hop in &hops {
            if seen.contains(hop) {
                return Err(DomainError::CohortPathInvalid(format!(
                    "{hop} appears twice in the same path"
                )));
            }
            seen.push(*hop);
        }
        Ok(Self {
            root,
            hops,
            admitted_by,
        })
    }

    /// A path of one cohort: the root admitted the principal itself.
    ///
    /// # Errors
    ///
    /// As [`EligibilityPath::new`].
    pub fn direct(root: CohortId, admitted_by: CohortMember) -> Result<Self, DomainError> {
        Self::new(root, Vec::new(), admitted_by)
    }

    /// The cohort the question was asked about.
    #[must_use]
    pub fn root(&self) -> CohortId {
        self.root
    }

    /// The nested cohorts descended into, excluding the root.
    #[must_use]
    pub fn hops(&self) -> &[CohortId] {
        &self.hops
    }

    /// The row that admitted the principal — a direct principal or a team.
    #[must_use]
    pub fn admitted_by(&self) -> CohortMember {
        self.admitted_by
    }

    /// How many cohorts the path passes through, counting the root. Never
    /// exceeds [`MAX_COHORT_DEPTH`].
    #[must_use]
    pub fn depth(&self) -> usize {
        self.hops.len() + 1
    }

    /// The cohort that directly contains the admitting row — the last cohort on
    /// the path. This is the one an operator edits to end this route.
    #[must_use]
    pub fn admitting_cohort(&self) -> CohortId {
        self.hops.last().copied().unwrap_or(self.root)
    }

    /// Whether this path passes through `cohort_id` at all.
    ///
    /// The question asked when a cohort is about to be edited or deleted: every
    /// eligibility whose path contains it is one that edit could end.
    #[must_use]
    pub fn passes_through(&self, cohort_id: CohortId) -> bool {
        self.root == cohort_id || self.hops.contains(&cohort_id)
    }

    /// Whether the principal was admitted by a named team rather than by being
    /// listed individually — the reuse case.
    #[must_use]
    pub fn is_via_team(&self) -> bool {
        matches!(self.admitted_by, CohortMember::Team { .. })
    }

    /// One canonical line, stable enough to digest and plain enough to read.
    ///
    /// ASCII on purpose. This string goes into the roster digest that binds a
    /// snapshot, so it must not depend on a renderer's taste in arrows; a UI is
    /// free to draw the separator however it likes from [`Self::hops`].
    #[must_use]
    pub fn canonical(&self) -> String {
        let mut out = self.root.to_string();
        for hop in &self.hops {
            out.push_str(" > ");
            out.push_str(&hop.to_string());
        }
        out.push_str(" > ");
        out.push_str(&self.admitted_by.to_string());
        out
    }
}

impl fmt::Display for EligibilityPath {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.canonical())
    }
}

/// One principal's eligibility, with its explanation.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Eligibility {
    pub principal_id: PrincipalId,
    /// The canonical route: the shortest one, ties broken by the order members
    /// are stored in. Deterministic, so the same graph always explains itself
    /// the same way and a diff only moves when the graph does.
    pub path: EligibilityPath,
    /// How many *other* cohorts on the resolved graph also admit this principal.
    ///
    /// The number an operator needs before they believe a removal did something.
    /// Zero means [`Self::path`] is the only route, and editing it ends this
    /// eligibility; anything higher means the principal stays eligible after
    /// that edit, by a route this record is telling you about rather than
    /// leaving you to discover.
    pub additional_admissions: usize,
}

impl Eligibility {
    /// Whether this eligibility survives the removal of one cohort from the
    /// graph.
    ///
    /// Conservative on purpose: with other admitting cohorts present it answers
    /// "yes, it survives" without working out whether those routes also pass
    /// through `cohort_id`. An operator over-warned re-reads the roster; an
    /// operator under-warned believes access ended when it did not.
    #[must_use]
    pub fn survives_removal_of(&self, cohort_id: CohortId) -> bool {
        if !self.path.passes_through(cohort_id) {
            return true;
        }
        self.additional_admissions > 0
    }
}
