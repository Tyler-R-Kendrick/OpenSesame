//! The answer a cohort gives: who is eligible, why, and when that was worked out.

use crate::{canonical::digest_json, CohortId, DomainError, Eligibility, GraphShape, PrincipalId};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeMap;

/// Who a cohort makes eligible, and why, keyed by principal.
pub type Roster = BTreeMap<PrincipalId, Eligibility>;

/// One resolution of one cohort, at the instant it was computed.
///
/// Carries `resolved_at` because a live admission is only as good as the moment it
/// was taken: [`AdmissionBasis`](crate::AdmissionBasis) refuses a resolution older
/// than [`MAX_LIVE_RESOLUTION_AGE`](crate::MAX_LIVE_RESOLUTION_AGE), which is the
/// whole difference between a live cohort and a cached one.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct CohortResolution {
    pub cohort_id: CohortId,
    pub resolved_at: DateTime<Utc>,
    pub roster: Roster,
    /// The shape the traversal found, so a readout can say "three levels, nine
    /// cohorts" without walking the graph again.
    pub shape: GraphShape,
}

impl CohortResolution {
    /// Whether this resolution makes `principal_id` eligible, and why.
    #[must_use]
    pub fn eligibility(&self, principal_id: PrincipalId) -> Option<&Eligibility> {
        self.roster.get(&principal_id)
    }

    #[must_use]
    pub fn len(&self) -> usize {
        self.roster.len()
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.roster.is_empty()
    }

    /// The digest that binds this roster.
    ///
    /// # Errors
    ///
    /// [`DomainError::Canonicalization`] if the projection cannot be
    /// canonicalized.
    pub fn roster_digest(&self) -> Result<String, DomainError> {
        roster_digest(self.cohort_id, &self.roster)
    }
}

/// Digest a roster, over an explicitly written projection.
///
/// Not over the serde form. This digest is persisted inside snapshots and compared
/// on every snapshot-based admission, so it must not move when a `derive` is
/// refactored or a field is added for a screen — a digest that changed for reasons
/// unrelated to membership would make every stored snapshot unverifiable at once.
/// The projection below is the contract: principal, canonical path, and how many
/// other rows admit them.
///
/// # Errors
///
/// [`DomainError::Canonicalization`] if the projection cannot be canonicalized.
pub fn roster_digest(cohort_id: CohortId, roster: &Roster) -> Result<String, DomainError> {
    let rows: Vec<Value> = roster
        .values()
        .map(|eligibility| {
            json!({
                "principal": eligibility.principal_id.to_string(),
                "path": eligibility.path.canonical(),
                "additional_admissions": eligibility.additional_admissions,
            })
        })
        .collect();
    digest_json(&json!({
        "cohort": cohort_id.to_string(),
        "roster": rows,
    }))
}
