//! Adversarial tests: the recombinations a correlated permission must refuse.
//!
//! Each test names the move an attacker (or an honest refactor) would make to
//! get a pair nobody granted, and asserts the refusal. They live apart from the
//! per-module tests because they are the contract, not the unit behaviour: if
//! one of these ever passes, the type has stopped being worth having.

use super::{
    DynamicPermissionRule, PermissionEntry, PermissionManifest, PermissionRole, PermissionSet,
    ResourceScope, ResourceTemplate, RoleCatalog,
};
use crate::DomainError;
use std::collections::BTreeMap;

fn read_a_write_b() -> PermissionSet {
    PermissionSet::new(vec![
        PermissionEntry::new(&["repository.read"], &["repo:acme/a"]).unwrap(),
        PermissionEntry::new(&["repository.write"], &["repo:acme/b"]).unwrap(),
    ])
    .unwrap()
}

#[test]
fn adversarial_the_headline_case_write_a_is_never_authorized() {
    let set = read_a_write_b();
    assert!(!set.permits("repository.write", "repo:acme/a"));
    assert!(!set.permits("repository.read", "repo:acme/b"));
    // And the two halves each being present somewhere is not the question.
    assert!(set.projected_actions().contains(&"repository.write".into()));
    assert!(set
        .projected_scopes()
        .contains(&ResourceScope::parse("repo:acme/a").unwrap()));
}

#[test]
fn adversarial_flattening_is_the_hole_and_it_is_now_an_error() {
    // The exact conversion that used to happen silently on the way to a grant.
    let error = read_a_write_b().flatten_lossless().unwrap_err();
    match error {
        DomainError::PermissionCorrelationLost(pair) => {
            // The refusal names a pair that would have been gained.
            assert!(
                pair == "repository.read on repo:acme/b"
                    || pair == "repository.write on repo:acme/a",
                "{pair}"
            );
        }
        other => panic!("expected a correlation-loss refusal, got {other}"),
    }
}

#[test]
fn adversarial_attenuation_cannot_draw_halves_from_different_parent_entries() {
    let parent = read_a_write_b();
    for (action, resource) in [
        ("repository.write", "repo:acme/a"),
        ("repository.read", "repo:acme/b"),
    ] {
        let child = PermissionSet::new(vec![PermissionEntry::new(&[action], &[resource]).unwrap()])
            .unwrap();
        assert!(
            !child.attenuates(&parent),
            "{action} on {resource} must not attenuate"
        );
    }
}

#[test]
fn adversarial_a_child_cannot_merge_two_parent_entries_into_one() {
    let parent = read_a_write_b();
    let merged = PermissionSet::new(vec![PermissionEntry::new(
        &["repository.read", "repository.write"],
        &["repo:acme/a", "repo:acme/b"],
    )
    .unwrap()])
    .unwrap();
    assert!(!merged.attenuates(&parent));
}

#[test]
fn adversarial_a_subtree_child_cannot_swallow_two_exact_parents() {
    let parent = PermissionSet::new(vec![
        PermissionEntry::new(&["repository.read"], &["repo:acme/a"]).unwrap(),
        PermissionEntry::new(&["repository.read"], &["repo:acme/b"]).unwrap(),
    ])
    .unwrap();
    let child = PermissionSet::new(vec![PermissionEntry::new(
        &["repository.read"],
        &["repo:acme/*"],
    )
    .unwrap()])
    .unwrap();
    assert!(!child.attenuates(&parent));
    // Nor does `*` slip through as "the same thing, briefer".
    let everything = PermissionSet::new(vec![
        PermissionEntry::new(&["repository.read"], &["*"]).unwrap()
    ])
    .unwrap();
    assert!(!everything.attenuates(&parent));
}

#[test]
fn adversarial_a_bare_prefix_never_becomes_a_subtree() {
    // The classic: `repo:acme` reaching `repo:acme-private/secrets`.
    assert!(ResourceScope::parse("repo:acme*").is_err());
    let exact = ResourceScope::parse("repo:acme").unwrap();
    assert!(!exact.matches("repo:acme-private/secrets"));
    assert!(!exact.matches("repo:acme/catalog"));

    let subtree = ResourceScope::parse("repo:acme/*").unwrap();
    assert!(!subtree.matches("repo:acme-private/secrets"));
    assert!(!subtree.contains(&ResourceScope::parse("repo:acme-private/*").unwrap()));
}

#[test]
fn adversarial_two_roles_are_not_one_wider_role() {
    let mut catalog = RoleCatalog::new();
    catalog
        .define(
            PermissionRole::new(
                "reader",
                vec![PermissionEntry::new(&["repository.read"], &["repo:acme/a"]).unwrap()],
            )
            .unwrap(),
        )
        .unwrap();
    catalog
        .define(
            PermissionRole::new(
                "writer",
                vec![PermissionEntry::new(&["repository.write"], &["repo:acme/b"]).unwrap()],
            )
            .unwrap(),
        )
        .unwrap();
    let both = catalog.expand(&["reader", "writer"]).unwrap();
    assert!(!both.permits("repository.write", "repo:acme/a"));
    assert!(matches!(
        both.flatten_lossless(),
        Err(DomainError::PermissionCorrelationLost(_))
    ));
}

#[test]
fn adversarial_a_dynamic_resource_cannot_climb_out_of_its_ceiling() {
    let rule = DynamicPermissionRule::new(
        &["pull_request.create"],
        ResourceTemplate::parse("repo:acme/{repository}").unwrap(),
        ResourceScope::parse("repo:acme/*").unwrap(),
    )
    .unwrap();
    for hostile in ["../victim", "a/../../victim", "*", "a:b", "a/b"] {
        let bindings: BTreeMap<String, String> = [("repository".to_string(), hostile.to_string())]
            .into_iter()
            .collect();
        assert!(rule.bind(&bindings).is_err(), "{hostile:?} must not bind");
    }
}

#[test]
fn adversarial_a_manifest_survives_the_round_trip_that_used_to_flatten_it() {
    let details = vec![
        serde_json::json!({
            "type": "connector_operation",
            "actions": ["repository.read"],
            "locations": ["repo:acme/a"],
        }),
        serde_json::json!({
            "type": "connector_operation",
            "actions": ["repository.write"],
            "locations": ["repo:acme/b"],
        }),
    ];
    let set = PermissionManifest::from_authorization_details(&details)
        .unwrap()
        .to_permission_set()
        .unwrap();
    assert_eq!(set, read_a_write_b());
    assert!(!set.permits("repository.write", "repo:acme/a"));

    // Whereas the flat grant the old path would have produced authorizes it —
    // which is what makes the refusal above load-bearing rather than cosmetic.
    let flattened = PermissionSet::from_flat(
        &["repository.read", "repository.write"],
        &["repo:acme/a", "repo:acme/b"],
    )
    .unwrap();
    assert!(flattened.permits("repository.write", "repo:acme/a"));
    assert_ne!(set, flattened);
}

#[test]
fn adversarial_an_entry_with_no_resources_is_not_an_entry_with_every_resource() {
    let no_resources: [&str; 0] = [];
    assert!(PermissionEntry::new(&["repository.read"], &no_resources).is_err());
    let no_actions: [&str; 0] = [];
    assert!(PermissionEntry::new(&no_actions, &["repo:acme/a"]).is_err());
    // An empty set is empty authority, not open authority.
    assert!(!PermissionSet::empty().permits("repository.read", "repo:acme/a"));
}
