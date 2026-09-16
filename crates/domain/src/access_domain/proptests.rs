//! Property tests for the forest's defining claim: it is always a forest.
//!
//! Three things are proven here over generated shapes rather than by example:
//!
//! 1. However a forest is assembled through the public mutations, every node's
//!    parent walk terminates at a root and no node is its own ancestor.
//! 2. A reparent is accepted *exactly* when the new parent is outside the moved
//!    subtree — refused every other time, and never leaving a cycle behind.
//! 3. A forest that somehow *is* cyclic — rehydrated from storage that lost the
//!    invariant — reports [`DomainError::AccessDomainCycle`] on the first read
//!    instead of spinning.

use super::{AccessDomain, AccessDomainForest, Realm, MAX_DOMAIN_DEPTH};
use crate::{AccessDomainId, DomainError, ProjectId};
use chrono::{DateTime, Utc};
use proptest::prelude::*;
use std::collections::BTreeSet;

fn now() -> DateTime<Utc> {
    DateTime::parse_from_rfc3339("2026-03-01T00:00:00Z")
        .expect("fixture timestamp")
        .with_timezone(&Utc)
}

/// One node's intended parent: `None` for a root, `Some(k)` for "the k-th node
/// created so far, modulo how many there are".
type Plan = Vec<Option<usize>>;

fn arb_plan() -> impl Strategy<Value = Plan> {
    prop::collection::vec(prop::option::of(0usize..40), 1..25)
}

fn arb_moves() -> impl Strategy<Value = Vec<(usize, Option<usize>)>> {
    prop::collection::vec((0usize..40, prop::option::of(0usize..40)), 0..12)
}

/// Build a forest from a plan. Slugs are unique per index, so the only
/// legitimate refusal is the depth cap — a node the plan wanted but the forest
/// would not take is simply left out, which is what a caller would do.
fn build(plan: &Plan) -> (AccessDomainForest, Vec<AccessDomainId>) {
    let mut forest = AccessDomainForest::new(Realm::standard(None, ProjectId::new()));
    let mut created: Vec<AccessDomainId> = Vec::new();
    for (index, parent) in plan.iter().enumerate() {
        let id = AccessDomainId::new();
        let slug = format!("d{index}");
        let outcome = match parent {
            Some(pick) if !created.is_empty() => {
                let parent_id = created[pick % created.len()];
                forest.create_child(id, parent_id, &slug, &slug, now())
            }
            _ => forest.create_root(id, &slug, &slug, now()),
        };
        if outcome.is_ok() {
            created.push(id);
        }
    }
    (forest, created)
}

/// Every parent walk terminates, visits each node at most once, and ends at a
/// root inside the depth cap.
fn assert_walks_terminate(forest: &AccessDomainForest) -> Result<(), TestCaseError> {
    for domain in forest.domains() {
        let ancestors = forest
            .ancestors(domain.id())
            .map_err(|error| TestCaseError::fail(format!("ancestor walk failed: {error}")))?;
        let unique: BTreeSet<AccessDomainId> = ancestors.iter().copied().collect();
        prop_assert_eq!(unique.len(), ancestors.len(), "an ancestor repeated");
        prop_assert!(
            !ancestors.contains(&domain.id()),
            "a node is its own ancestor"
        );
        if let Some(root) = ancestors.last() {
            let root_node = forest
                .get(*root)
                .ok_or_else(|| TestCaseError::fail("dangling root"))?;
            prop_assert!(
                root_node.is_root(),
                "a walk ended somewhere other than a root"
            );
        } else {
            prop_assert!(domain.is_root(), "a node with no ancestors must be a root");
        }
        // Depth counts the node itself, so the ancestor chain is one shorter.
        prop_assert!(ancestors.len() < MAX_DOMAIN_DEPTH, "past the depth cap");
    }
    Ok(())
}

proptest! {
    #[test]
    fn any_assembled_forest_is_acyclic(plan in arb_plan()) {
        let (forest, created) = build(&plan);
        prop_assert!(forest.assert_acyclic().is_ok());
        prop_assert_eq!(forest.len(), created.len());
        assert_walks_terminate(&forest)?;
    }

    #[test]
    fn paths_identify_domains_uniquely(plan in arb_plan()) {
        let (forest, _) = build(&plan);
        let mut paths = BTreeSet::new();
        for domain in forest.domains() {
            let path = forest
                .path(domain.id())
                .map_err(|error| TestCaseError::fail(format!("path failed: {error}")))?;
            prop_assert!(paths.insert(path), "two domains share a path");
        }
    }

    #[test]
    fn a_move_is_accepted_exactly_when_it_leaves_a_forest(
        plan in arb_plan(),
        moves in arb_moves(),
    ) {
        let (mut forest, created) = build(&plan);
        prop_assume!(!created.is_empty());
        for (subject_pick, parent_pick) in moves {
            let subject = created[subject_pick % created.len()];
            let parent = parent_pick.map(|pick| created[pick % created.len()]);
            let would_cycle = match parent {
                None => false,
                Some(parent_id) => forest
                    .is_in_subtree_of(parent_id, subject)
                    .map_err(|error| {
                        TestCaseError::fail(format!("subtree walk failed: {error}"))
                    })?,
            };
            let outcome = forest.reparent(subject, parent);
            if would_cycle {
                prop_assert!(
                    matches!(outcome, Err(DomainError::AccessDomainCycle(_))),
                    "a move into the moved subtree must be refused as a cycle",
                );
            } else {
                // The remaining refusals are the depth cap and a sibling slug
                // clash; neither may leave the forest changed or cyclic.
                prop_assert!(
                    !matches!(outcome, Err(DomainError::AccessDomainCycle(_))),
                    "a legal move must not be reported as a cycle",
                );
            }
            prop_assert!(forest.assert_acyclic().is_ok());
            assert_walks_terminate(&forest)?;
        }
    }

    #[test]
    fn removing_a_subtree_never_leaves_a_dangling_parent(
        plan in arb_plan(),
        victim in 0usize..40,
    ) {
        let (mut forest, created) = build(&plan);
        prop_assume!(!created.is_empty());
        let subject = created[victim % created.len()];
        let removed = forest
            .remove_subtree(subject)
            .map_err(|error| TestCaseError::fail(format!("removal failed: {error}")))?;
        prop_assert!(!removed.is_empty());
        prop_assert!(!forest.contains(subject));
        for domain in forest.domains() {
            if let Some(parent) = domain.parent_id() {
                prop_assert!(
                    forest.contains(parent),
                    "a survivor points at a removed parent"
                );
            }
        }
        prop_assert!(forest.assert_acyclic().is_ok());
        assert_walks_terminate(&forest)?;
    }

    #[test]
    fn a_node_from_another_realm_is_never_admitted(plan in arb_plan()) {
        let (mut forest, _) = build(&plan);
        let elsewhere = Realm::standard(None, ProjectId::new());
        let stranger = AccessDomain::root(
            AccessDomainId::new(),
            elsewhere,
            "stranger",
            "Stranger",
            now(),
        )
        .map_err(|error| TestCaseError::fail(format!("node build failed: {error}")))?;
        prop_assert!(matches!(
            forest.insert(stranger),
            Err(DomainError::AccessDomainRealmMismatch(_))
        ));
    }
}

/// A cyclic forest can only arrive by deserialization — the mutations refuse to
/// make one — so that is how this test produces it. The point is that the reads
/// fail loudly rather than looping forever on data that lost the invariant.
#[test]
fn a_rehydrated_cycle_is_reported_rather_than_walked() {
    let mut forest = AccessDomainForest::new(Realm::standard(None, ProjectId::new()));
    let upper = forest
        .create_root(AccessDomainId::new(), "upper", "Upper", now())
        .expect("root inserts");
    let lower = forest
        .create_child(AccessDomainId::new(), upper, "lower", "Lower", now())
        .expect("child inserts");

    let mut wire = serde_json::to_value(&forest).expect("forest serializes");
    let upper_key = upper.as_uuid().to_string();
    let lower_key = lower.as_uuid().to_string();
    wire["nodes"][&upper_key]["parent_id"] = serde_json::Value::String(lower_key);
    let cyclic: AccessDomainForest =
        serde_json::from_value(wire).expect("a cycle still deserializes");

    assert!(matches!(
        cyclic.ancestors(lower),
        Err(DomainError::AccessDomainCycle(_))
    ));
    assert!(matches!(
        cyclic.assert_acyclic(),
        Err(DomainError::AccessDomainCycle(_))
    ));
    assert!(
        cyclic.roots().is_empty(),
        "a cyclic forest has no roots, which is itself a signal"
    );
    assert!(matches!(
        cyclic.path(upper),
        Err(DomainError::AccessDomainCycle(_))
    ));
}
