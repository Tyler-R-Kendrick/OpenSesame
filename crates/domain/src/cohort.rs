//! Cohorts: groups that decide **who may ask**, never groups that hold
//! authority of their own.
//!
//! A cohort is a named, possibly nested group — the on-call rotation, the
//! security reviewers, everyone in the incident channel. It composes principals
//! directly, existing [`TeamId`]s, and other cohorts.
//!
//! The whole module rests on one separation, and every type here exists to keep
//! it:
//!
//! **A group defines eligibility. An activation binds an individual.**
//!
//! Being in a cohort is never itself permission to do anything. It makes a
//! principal *eligible* to be bound, one at a time, by a
//! [`CohortActivation`](crate::CohortActivation) that names them and nobody
//! else. There is deliberately no cohort-wide credential anywhere in this
//! module — no token minted for "the reviewers", no shared secret handed to a
//! roster, nothing a member could pass to a non-member. That is not an
//! omission we might fill in later: a credential issued to a group cannot say
//! which member used it, so a receipt naming a group is a receipt naming
//! nobody. The types here carry no secret material at all, which is why a
//! cohort record and an activation record are both safe to log whole.
//!
//! ## Reuse before restatement
//!
//! [`CohortMember::Team`] exists so a cohort that means "the platform team"
//! *names* the platform team rather than copying its roster. A copied roster is
//! a roster that goes stale silently: somebody leaves the team, and the cohort
//! keeps them eligible because nothing connected the two. Prefer naming a team
//! or a nested cohort; a direct principal member is for somebody who belongs
//! to no group that already describes them.
//!
//! [`CohortResolution`](crate::CohortResolution) reports the same thing from the
//! other side: a principal admitted by more than one route carries a non-zero
//! `additional_admissions`, so an operator who removes one route is told
//! whether they actually ended anybody's eligibility.
//!
//! ## Bounds are the point, not a limit we happened to pick
//!
//! Nesting is what makes cohorts worth having and also what makes them
//! dangerous: "the reviewers" containing "the leads" containing "the on-call"
//! is a chain nobody has read end to end. Every bound in this module keeps
//! resolution finite and keeps a human able to hold the answer in their head.
//! They are refusals rather than clamps — an operator told their cohort was
//! accepted believes something true about it.
//!
//! Persisted strings here (the `kind` tags, the field names, the id prefixes)
//! are written into stored rows and into the digests that bind snapshots. They
//! are frozen: renaming one silently invalidates every snapshot taken before
//! the rename.

use crate::{CohortId, DomainError, PrincipalId, TeamId};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use std::fmt;

/// How deep a chain of nested cohorts may run, counting the root.
///
/// Four is a shape somebody can still explain: a cohort, the groups it names,
/// the groups those name, and one more. The bound is on the longest chain in
/// the graph rather than on the route resolution happens to take, so a deep
/// branch nobody's test exercises is refused when the cohort is saved rather
/// than discovered later by whoever is paged.
pub const MAX_COHORT_DEPTH: usize = 4;

/// How many members one cohort may name directly.
pub const MAX_COHORT_MEMBERS: usize = 128;
/// How many cohorts one resolution may visit.
///
/// This is what keeps traversal — and the recursion that validates it — finite
/// on a graph assembled by somebody careless or hostile. A chain longer than
/// this is refused at the 64th node, so validation never descends far enough to
/// exhaust a stack.
pub const MAX_COHORT_NODES: usize = 64;

/// How many principals one cohort may make eligible.
///
/// A cohort past this size is a broadcast, and a broadcast is not an
/// authorization boundary. Refusing it here means the roster a snapshot stores
/// and the diff an operator reads both stay bounded.
pub const MAX_ELIGIBLE_PRINCIPALS: usize = 2048;

/// How much of an operator-supplied cohort label is kept.
pub const MAX_COHORT_LABEL_CHARS: usize = 120;

/// One row of a cohort's membership.
///
/// The `kind` tags — `principal`, `team`, `cohort` — and the field names are
/// persisted and digest-bound. Do not rename them.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "kind")]
pub enum CohortMember {
    /// One named principal. For somebody no existing group describes.
    Principal { principal_id: PrincipalId },
    /// An existing team, by reference. The reuse path: the team's roster stays
    /// the team's, and this cohort follows it.
    Team { team_id: TeamId },
    /// Another cohort, nested. Bounded by [`MAX_COHORT_DEPTH`].
    Cohort { cohort_id: CohortId },
}

impl CohortMember {
    /// The nested cohort this row names, if it names one.
    #[must_use]
    pub fn nested_cohort(&self) -> Option<CohortId> {
        match self {
            Self::Cohort { cohort_id } => Some(*cohort_id),
            Self::Principal { .. } | Self::Team { .. } => None,
        }
    }

    /// Whether this row admits principals directly, rather than by descending
    /// into another cohort. A path's last hop is always one of these.
    #[must_use]
    pub fn is_leaf(&self) -> bool {
        self.nested_cohort().is_none()
    }
}

impl fmt::Display for CohortMember {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Principal { principal_id } => write!(f, "{principal_id}"),
            Self::Team { team_id } => write!(f, "{team_id}"),
            Self::Cohort { cohort_id } => write!(f, "{cohort_id}"),
        }
    }
}

/// When a cohort's membership is read: once and frozen, or at every use.
///
/// The two are not interchangeable and picking between them is the operator's
/// decision, not an implementation detail, so it is a field on the cohort
/// rather than an argument at the call site. A cohort declares its discipline
/// once and every activation is held to it — which is what
/// [`AdmissionBasis`](crate::AdmissionBasis) checks.
///
/// The serialized names are persisted. Do not rename them.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AdmissionMode {
    /// Eligibility is whatever the graph says at the moment of activation.
    ///
    /// For a cohort that must track reality: somebody added to the on-call
    /// rotation can act, and somebody removed cannot, without an operator
    /// having to re-take anything. The cost is that the answer moves, so a
    /// resolution used for admission must be fresh — see
    /// [`MAX_LIVE_RESOLUTION_AGE`](crate::MAX_LIVE_RESOLUTION_AGE).
    Live,
    /// Eligibility is a frozen roster, taken once and digest-bound.
    ///
    /// For authority that must not widen under an operator's feet: whoever was
    /// eligible when the snapshot was taken stays eligible, and adding somebody
    /// to a nested team afterwards does not reach this cohort. The cost is that
    /// the answer goes stale on purpose, so a removal does not take effect until
    /// a new snapshot is taken.
    Snapshot,
}

/// A group, as stored.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Cohort {
    pub id: CohortId,
    /// The boundary this cohort lives in. Membership never crosses it.
    pub organization_id: crate::OrganizationId,
    /// Operator-supplied, shown to humans. Untrusted text: whatever renders it
    /// escapes it.
    pub label: String,
    /// Ordered and deduplicated, so the same membership always serializes the
    /// same way and therefore digests the same way.
    pub members: BTreeSet<CohortMember>,
    pub admission: AdmissionMode,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

/// Everything a new cohort needs, named.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NewCohort {
    pub id: CohortId,
    pub organization_id: crate::OrganizationId,
    pub label: String,
    pub members: BTreeSet<CohortMember>,
    pub admission: AdmissionMode,
    pub created_at: DateTime<Utc>,
}
impl Cohort {
    /// Create a cohort, refusing every shape that cannot be resolved.
    ///
    /// # Errors
    ///
    /// - [`DomainError::CohortLabelInvalid`] for an empty, over-long, or
    ///   control-character-bearing label.
    /// - [`DomainError::CohortEmpty`] for a cohort naming no members. A group
    ///   that makes nobody eligible is a mistake rather than a closed door:
    ///   an operator who meant "nobody" deletes the cohort.
    /// - [`DomainError::CohortTooManyMembers`] past [`MAX_COHORT_MEMBERS`].
    /// - [`DomainError::CohortCycle`] when a cohort names itself. Longer loops
    ///   need the rest of the graph and are caught by
    ///   [`CohortGraph::validate`](crate::CohortGraph::validate).
    pub fn new(spec: NewCohort) -> Result<Self, DomainError> {
        let NewCohort {
            id,
            organization_id,
            label,
            members,
            admission,
            created_at,
        } = spec;
        let label = validate_label(&label)?;
        if members.is_empty() {
            return Err(DomainError::CohortEmpty);
        }
        if members.len() > MAX_COHORT_MEMBERS {
            return Err(DomainError::CohortTooManyMembers(members.len()));
        }
        if members.contains(&CohortMember::Cohort { cohort_id: id }) {
            return Err(DomainError::CohortCycle(format!(
                "{id} names itself as a member"
            )));
        }
        Ok(Self {
            id,
            organization_id,
            label,
            members,
            admission,
            created_at,
            updated_at: created_at,
        })
    }

    /// The nested cohorts this one names, in a stable order.
    #[must_use]
    pub fn nested(&self) -> Vec<CohortId> {
        self.members
            .iter()
            .filter_map(CohortMember::nested_cohort)
            .collect()
    }

    /// The rows that admit principals without descending — direct principals
    /// and teams, in a stable order.
    #[must_use]
    pub fn leaves(&self) -> Vec<CohortMember> {
        self.members
            .iter()
            .copied()
            .filter(CohortMember::is_leaf)
            .collect()
    }

    /// Replace the membership, holding the same bounds as creation.
    ///
    /// Editing goes through here rather than through a public field so a cohort
    /// cannot be grown past [`MAX_COHORT_MEMBERS`] one push at a time.
    ///
    /// # Errors
    ///
    /// As [`Cohort::new`], for the membership checks.
    pub fn with_members(
        self,
        members: BTreeSet<CohortMember>,
        updated_at: DateTime<Utc>,
    ) -> Result<Self, DomainError> {
        if members.is_empty() {
            return Err(DomainError::CohortEmpty);
        }
        if members.len() > MAX_COHORT_MEMBERS {
            return Err(DomainError::CohortTooManyMembers(members.len()));
        }
        if members.contains(&CohortMember::Cohort { cohort_id: self.id }) {
            return Err(DomainError::CohortCycle(format!(
                "{} names itself as a member",
                self.id
            )));
        }
        Ok(Self {
            members,
            updated_at,
            ..self
        })
    }
}

/// Trim, then refuse what a human cannot read or a log cannot hold safely.
///
/// Control characters are refused rather than stripped: a label containing a
/// newline is somebody trying to forge a second line in whatever renders the
/// roster, and quietly repairing it would hide the attempt.
fn validate_label(label: &str) -> Result<String, DomainError> {
    let trimmed = label.trim();
    if trimmed.is_empty() {
        return Err(DomainError::CohortLabelInvalid("empty".into()));
    }
    let length = trimmed.chars().count();
    if length > MAX_COHORT_LABEL_CHARS {
        return Err(DomainError::CohortLabelInvalid(format!(
            "{length} characters is longer than the {MAX_COHORT_LABEL_CHARS} character maximum"
        )));
    }
    if trimmed.chars().any(char::is_control) {
        return Err(DomainError::CohortLabelInvalid(
            "contains a control character".into(),
        ));
    }
    Ok(trimmed.to_string())
}
