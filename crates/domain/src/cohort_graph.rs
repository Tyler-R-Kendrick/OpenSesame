//! Resolving a nested cohort into the principals it makes eligible.
//!
//! Two passes, deliberately separate.
//!
//! 1. [`CohortGraph::validate`] answers whether the graph is a shape we are
//!    willing to traverse: acyclic, no deeper than [`MAX_COHORT_DEPTH`], no
//!    larger than [`MAX_COHORT_NODES`], with every named member present and
//!    inside the same organization. A save path calls it, so a cohort nobody can
//!    resolve is refused when it is written rather than when somebody is waiting
//!    on an authorization.
//! 2. [`CohortGraph::resolve`] walks the validated graph breadth-first and
//!    produces the roster, each principal carrying the shortest route that
//!    admitted them.
//!
//! ## Fail closed, and loudly
//!
//! A member this graph cannot resolve — a nested cohort that was deleted, a team
//! the caller never loaded — is [`DomainError::CohortUnresolvedMember`], never an
//! empty contribution. Treating a missing node as "contributes nobody" sounds
//! like the safe direction and is the worst option available: a directory that
//! failed to load then looks exactly like a team somebody emptied on purpose. It
//! would let an outage take a snapshot of nearly nobody, and let a diff report a
//! mass removal that never happened. The resolution refuses instead, and the
//! caller either loads what it missed or reports that it cannot answer.

use crate::{
    Cohort, CohortId, CohortMember, CohortResolution, DomainError, Eligibility, EligibilityPath,
    PrincipalId, Roster, TeamId, MAX_COHORT_DEPTH, MAX_COHORT_NODES, MAX_ELIGIBLE_PRINCIPALS,
};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::collections::btree_map::Entry;
use std::collections::{BTreeMap, BTreeSet, VecDeque};

/// The cohorts and team rosters a resolution may read.
///
/// A value, not a service. The domain does no I/O: a caller loads the closure of
/// a cohort — the cohort, everything it nests, and the teams those name — puts it
/// here, and resolution is then a pure function of it. That is what makes a
/// resolution reproducible from an audit record.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct CohortGraph {
    cohorts: BTreeMap<CohortId, Cohort>,
    teams: BTreeMap<TeamId, BTreeSet<PrincipalId>>,
}

/// What [`CohortGraph::validate`] found: the shape, once it is known to be legal.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct GraphShape {
    /// The longest chain of nested cohorts, counting the root.
    pub depth: usize,
    /// How many cohorts are reachable from the root, including it.
    pub cohorts_visited: usize,
}

impl CohortGraph {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Add a cohort. Replaces one already held under the same id.
    #[must_use]
    pub fn with_cohort(mut self, cohort: Cohort) -> Self {
        self.cohorts.insert(cohort.id, cohort);
        self
    }

    /// Add a team's roster.
    ///
    /// A team present with no members is a legitimate answer — the team exists
    /// and is empty. A team absent is not: see the module note on failing loudly.
    #[must_use]
    pub fn with_team(mut self, team_id: TeamId, members: BTreeSet<PrincipalId>) -> Self {
        self.teams.insert(team_id, members);
        self
    }

    #[must_use]
    pub fn cohort(&self, cohort_id: CohortId) -> Option<&Cohort> {
        self.cohorts.get(&cohort_id)
    }

    /// Check the shape of the graph reachable from `root`.
    ///
    /// # Errors
    ///
    /// - [`DomainError::CohortUnresolvedMember`] for a cohort or team this graph
    ///   does not hold, including `root` itself.
    /// - [`DomainError::CohortCycle`] for a loop, naming the edge that closed it.
    ///   Detected across the whole reachable graph rather than only along one
    ///   route, so `a → b → c → a` is caught however the walk arrives.
    /// - [`DomainError::CohortDepthExceeded`] when the longest chain of nested
    ///   cohorts runs past [`MAX_COHORT_DEPTH`].
    /// - [`DomainError::CohortGraphTooLarge`] past [`MAX_COHORT_NODES`]. Checked
    ///   as the walk descends, which is also what keeps its recursion shallow: a
    ///   ten-thousand-deep chain is refused at the 64th cohort, long before a
    ///   stack could run out.
    /// - [`DomainError::OrganizationMismatch`] when a nested cohort belongs to
    ///   another organization.
    pub fn validate(&self, root: CohortId) -> Result<GraphShape, DomainError> {
        let mut ancestors = BTreeSet::new();
        let mut longest = BTreeMap::new();
        let mut budget = MAX_COHORT_NODES;
        let depth = self.chain_from(root, &mut ancestors, &mut longest, &mut budget)?;
        if depth > MAX_COHORT_DEPTH {
            return Err(DomainError::CohortDepthExceeded(depth));
        }
        Ok(GraphShape {
            depth,
            cohorts_visited: longest.len(),
        })
    }

    /// The longest chain starting at `cohort_id`, memoized.
    ///
    /// `ancestors` is the route currently being walked, so an edge back into it
    /// is a cycle. `longest` doubles as the finished set: a cohort in it has been
    /// fully explored and cannot be part of an undiscovered loop, which is what
    /// keeps this linear in the graph rather than exponential in its paths.
    fn chain_from(
        &self,
        cohort_id: CohortId,
        ancestors: &mut BTreeSet<CohortId>,
        longest: &mut BTreeMap<CohortId, usize>,
        budget: &mut usize,
    ) -> Result<usize, DomainError> {
        if let Some(known) = longest.get(&cohort_id) {
            return Ok(*known);
        }
        if *budget == 0 {
            return Err(DomainError::CohortGraphTooLarge(MAX_COHORT_NODES));
        }
        *budget -= 1;

        let cohort = self.require_cohort(cohort_id)?;
        ancestors.insert(cohort_id);
        let mut depth = 1;
        for member in &cohort.members {
            depth = depth.max(self.member_chain(cohort, *member, ancestors, longest, budget)?);
        }
        ancestors.remove(&cohort_id);
        longest.insert(cohort_id, depth);
        Ok(depth)
    }

    /// The chain one member row contributes: one for a row that admits principals
    /// where it stands, and one more than the nested cohort's own chain for a row
    /// that descends.
    fn member_chain(
        &self,
        holder: &Cohort,
        member: CohortMember,
        ancestors: &mut BTreeSet<CohortId>,
        longest: &mut BTreeMap<CohortId, usize>,
        budget: &mut usize,
    ) -> Result<usize, DomainError> {
        match member {
            CohortMember::Principal { .. } => Ok(1),
            CohortMember::Team { team_id } => {
                self.require_team(team_id)?;
                Ok(1)
            }
            CohortMember::Cohort { cohort_id } => {
                if ancestors.contains(&cohort_id) {
                    return Err(DomainError::CohortCycle(format!(
                        "{} names {cohort_id}, which already contains it",
                        holder.id
                    )));
                }
                if self.require_cohort(cohort_id)?.organization_id != holder.organization_id {
                    return Err(DomainError::OrganizationMismatch);
                }
                Ok(self.chain_from(cohort_id, ancestors, longest, budget)? + 1)
            }
        }
    }

    /// Resolve `root` into the principals it makes eligible, each with the route
    /// that admitted them.
    ///
    /// Breadth-first, and each cohort is expanded once. Breadth-first because the
    /// shortest route is the one worth showing a human, and expand-once because a
    /// diamond — two cohorts both nesting a third — is legitimate reuse that must
    /// not cost an extra traversal, let alone an exponential one.
    ///
    /// The canonical path for a principal is therefore the shallowest route to
    /// them, ties broken by the stored order of the rows that admitted them.
    /// Deterministic, which is what lets [`CohortDiff`](crate::CohortDiff) treat a
    /// changed path as a real change rather than as traversal noise.
    ///
    /// # Errors
    ///
    /// Everything [`CohortGraph::validate`] raises — it runs first, and its bounds
    /// are re-checked here rather than assumed — plus
    /// [`DomainError::CohortTooManyPrincipals`] past [`MAX_ELIGIBLE_PRINCIPALS`].
    pub fn resolve(
        &self,
        root: CohortId,
        resolved_at: DateTime<Utc>,
    ) -> Result<CohortResolution, DomainError> {
        let shape = self.validate(root)?;
        let mut walk = Walk::new(root);
        while let Some((cohort_id, hops)) = walk.queue.pop_front() {
            let cohort = self.require_cohort(cohort_id)?;
            for member in &cohort.members {
                self.visit_member(&mut walk, cohort_id, &hops, *member)?;
            }
        }
        Ok(CohortResolution {
            cohort_id: root,
            resolved_at,
            roster: walk.roster,
            shape,
        })
    }

    /// One member row of the cohort at `at`, reached by `hops`.
    fn visit_member(
        &self,
        walk: &mut Walk,
        at: CohortId,
        hops: &[CohortId],
        member: CohortMember,
    ) -> Result<(), DomainError> {
        match member {
            CohortMember::Principal { principal_id } => {
                let path = EligibilityPath::new(walk.root, hops.to_vec(), member)?;
                walk.admit(principal_id, path, (at, member))
            }
            CohortMember::Team { team_id } => {
                let path = EligibilityPath::new(walk.root, hops.to_vec(), member)?;
                for principal_id in self.require_team(team_id)? {
                    walk.admit(*principal_id, path.clone(), (at, member))?;
                }
                Ok(())
            }
            CohortMember::Cohort { cohort_id } => {
                walk.enqueue(cohort_id, hops);
                Ok(())
            }
        }
    }

    fn require_cohort(&self, cohort_id: CohortId) -> Result<&Cohort, DomainError> {
        self.cohorts
            .get(&cohort_id)
            .ok_or_else(|| DomainError::CohortUnresolvedMember(cohort_id.to_string()))
    }

    fn require_team(&self, team_id: TeamId) -> Result<&BTreeSet<PrincipalId>, DomainError> {
        self.teams
            .get(&team_id)
            .ok_or_else(|| DomainError::CohortUnresolvedMember(team_id.to_string()))
    }
}

/// The mutable state of one breadth-first resolution.
///
/// A struct rather than five locals threaded through helpers: the invariant that
/// makes the traversal finite is that `expanded` and `queue` are only ever
/// touched together, and keeping them in one place with one `enqueue` is what
/// makes that hard to get wrong.
struct Walk {
    root: CohortId,
    queue: VecDeque<(CohortId, Vec<CohortId>)>,
    /// Cohorts already queued. Expand-once is what makes a diamond cost one
    /// traversal rather than two, and a wide graph finite rather than
    /// exponential.
    expanded: BTreeSet<CohortId>,
    roster: Roster,
    /// Every `(cohort, row)` that has admitted each principal, so a second route
    /// is counted once however many times the walk passes it.
    admitting: BTreeMap<PrincipalId, BTreeSet<(CohortId, CohortMember)>>,
}

impl Walk {
    fn new(root: CohortId) -> Self {
        let mut queue = VecDeque::new();
        queue.push_back((root, Vec::new()));
        let mut expanded = BTreeSet::new();
        expanded.insert(root);
        Self {
            root,
            queue,
            expanded,
            roster: Roster::new(),
            admitting: BTreeMap::new(),
        }
    }

    /// Queue a nested cohort, at most once.
    fn enqueue(&mut self, cohort_id: CohortId, hops: &[CohortId]) {
        if !self.expanded.insert(cohort_id) {
            return;
        }
        let mut nested = hops.to_vec();
        nested.push(cohort_id);
        self.queue.push_back((cohort_id, nested));
    }

    /// Record one admission, keeping the first route as canonical and counting
    /// the rest.
    ///
    /// The same row admitting the same principal twice is not another route — it
    /// is one row seen once, since each cohort is expanded once — so admissions
    /// are deduplicated by `(cohort, row)` before anything is counted.
    fn admit(
        &mut self,
        principal_id: PrincipalId,
        path: EligibilityPath,
        edge: (CohortId, CohortMember),
    ) -> Result<(), DomainError> {
        if !self.admitting.entry(principal_id).or_default().insert(edge) {
            return Ok(());
        }
        // The bound counts distinct principals, so it is checked only where one is
        // about to be added. Somebody admitted by a second row does not grow the
        // roster and must not be refused by its ceiling.
        if !self.roster.contains_key(&principal_id) && self.roster.len() >= MAX_ELIGIBLE_PRINCIPALS
        {
            return Err(DomainError::CohortTooManyPrincipals(
                MAX_ELIGIBLE_PRINCIPALS,
            ));
        }
        match self.roster.entry(principal_id) {
            Entry::Vacant(slot) => {
                slot.insert(Eligibility {
                    principal_id,
                    path,
                    additional_admissions: 0,
                });
            }
            Entry::Occupied(mut held) => {
                held.get_mut().additional_admissions += 1;
            }
        }
        Ok(())
    }
}
