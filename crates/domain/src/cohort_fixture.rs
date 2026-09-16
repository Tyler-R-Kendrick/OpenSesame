//! Builders shared by the cohort test modules.
//!
//! Fixed timestamps and explicitly built graphs: a cohort test that depends on
//! `Utc::now()` or on an iteration order it did not choose is a test that will
//! eventually disagree with itself about a security property.

use crate::{
    AdmissionBasis, AdmissionMode, Cohort, CohortActivation, CohortActivationId, CohortGraph,
    CohortId, CohortMember, DomainError, NewCohort, NewCohortActivation, OrganizationId,
    PrincipalId, TeamId,
};
use chrono::{DateTime, Duration, TimeZone, Utc};
use std::collections::BTreeSet;

/// The instant every fixture is built at.
pub(crate) fn t0() -> DateTime<Utc> {
    Utc.with_ymd_and_hms(2026, 1, 1, 0, 0, 0)
        .single()
        .expect("a fixed, valid instant")
}

pub(crate) fn principal_member(principal_id: PrincipalId) -> CohortMember {
    CohortMember::Principal { principal_id }
}

pub(crate) fn team_member(team_id: TeamId) -> CohortMember {
    CohortMember::Team { team_id }
}

pub(crate) fn nested_member(cohort_id: CohortId) -> CohortMember {
    CohortMember::Cohort { cohort_id }
}

pub(crate) fn member_set(members: &[CohortMember]) -> BTreeSet<CohortMember> {
    members.iter().copied().collect()
}

/// A cohort with a chosen id, so a parent can name it.
pub(crate) fn cohort_with_id(
    id: CohortId,
    organization_id: OrganizationId,
    members: &[CohortMember],
    admission: AdmissionMode,
) -> Cohort {
    Cohort::new(NewCohort {
        id,
        organization_id,
        label: "fixture cohort".to_string(),
        members: member_set(members),
        admission,
        created_at: t0(),
    })
    .expect("a fixture cohort is legal by construction")
}

pub(crate) fn live_cohort(
    id: CohortId,
    organization_id: OrganizationId,
    members: &[CohortMember],
) -> Cohort {
    cohort_with_id(id, organization_id, members, AdmissionMode::Live)
}

pub(crate) fn snapshot_cohort(
    id: CohortId,
    organization_id: OrganizationId,
    members: &[CohortMember],
) -> Cohort {
    cohort_with_id(id, organization_id, members, AdmissionMode::Snapshot)
}

/// The same graph with one team's roster replaced.
pub(crate) fn graph_with_team(
    graph: CohortGraph,
    team_id: TeamId,
    members: &[PrincipalId],
) -> CohortGraph {
    graph.with_team(team_id, members.iter().copied().collect::<BTreeSet<_>>())
}

/// A chain of `length` nested cohorts, the deepest naming `subject` directly.
///
/// Returns the graph and the root. The chain is the shape every depth bound is
/// really about: `root → a → b → …`, where nobody has read the whole thing.
pub(crate) fn nested_chain(
    length: usize,
    subject: PrincipalId,
    admission: AdmissionMode,
) -> (CohortGraph, CohortId) {
    assert!(length >= 1, "a chain has at least a root");
    let organization_id = OrganizationId::new();
    let ids: Vec<CohortId> = (0..length).map(|_| CohortId::new()).collect();
    let mut graph = CohortGraph::new();
    for (depth, id) in ids.iter().enumerate().rev() {
        let members = match ids.get(depth + 1) {
            Some(child) => vec![nested_member(*child)],
            None => vec![principal_member(subject)],
        };
        graph = graph.with_cohort(cohort_with_id(*id, organization_id, &members, admission));
    }
    (graph, ids[0])
}

/// One cohort naming one team of two people — the smallest graph in which
/// "membership changed" is a thing that can happen.
pub(crate) struct Fixture {
    pub(crate) graph: CohortGraph,
    pub(crate) cohort: Cohort,
    pub(crate) team_id: TeamId,
    pub(crate) dana: PrincipalId,
    pub(crate) ridley: PrincipalId,
}

pub(crate) fn fixture(admission: AdmissionMode) -> Fixture {
    let organization_id = OrganizationId::new();
    let cohort_id = CohortId::new();
    let team_id = TeamId::new();
    let (dana, ridley) = (PrincipalId::new(), PrincipalId::new());
    let cohort = cohort_with_id(
        cohort_id,
        organization_id,
        &[team_member(team_id)],
        admission,
    );
    let graph = graph_with_team(
        CohortGraph::new().with_cohort(cohort.clone()),
        team_id,
        &[dana, ridley],
    );
    Fixture {
        graph,
        cohort,
        team_id,
        dana,
        ridley,
    }
}

impl Fixture {
    /// The same graph with Ridley taken out of the team.
    pub(crate) fn without_ridley(&self) -> CohortGraph {
        graph_with_team(self.graph.clone(), self.team_id, &[self.dana])
    }
}

/// The request digest every fixture activation is bound to.
pub(crate) const REQUEST: &str = "sha256:request";

/// Mint an activation the ordinary way, so a test that is about something else
/// does not restate the whole spec.
pub(crate) fn mint(
    cohort: &Cohort,
    basis: AdmissionBasis<'_>,
    subject_principal_id: PrincipalId,
    at: DateTime<Utc>,
) -> Result<CohortActivation, DomainError> {
    CohortActivation::mint(NewCohortActivation {
        id: CohortActivationId::new(),
        cohort,
        basis,
        subject_principal_id,
        request_digest: REQUEST.to_string(),
        activated_at: at,
        expires_at: at + Duration::minutes(10),
    })
}
