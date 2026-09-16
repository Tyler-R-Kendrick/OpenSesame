//! Structural behaviour of the forest and its mutations.

use super::{
    AccessDomain, AccessDomainForest, DomainLifetime, ProjectKind, Realm, VaultBinding,
    MAX_DOMAIN_DEPTH,
};
use crate::{AccessDomainId, DomainError, ProjectId, VaultId};
use chrono::{DateTime, Duration, Utc};

fn now() -> DateTime<Utc> {
    DateTime::parse_from_rfc3339("2026-03-01T00:00:00Z")
        .expect("fixture timestamp")
        .with_timezone(&Utc)
}

fn standard_forest() -> AccessDomainForest {
    AccessDomainForest::new(Realm::standard(None, ProjectId::new()))
}

fn root(forest: &mut AccessDomainForest, slug: &str) -> AccessDomainId {
    forest
        .create_root(AccessDomainId::new(), slug, slug, now())
        .expect("root inserts")
}

fn child(forest: &mut AccessDomainForest, parent: AccessDomainId, slug: &str) -> AccessDomainId {
    forest
        .create_child(AccessDomainId::new(), parent, slug, slug, now())
        .expect("child inserts")
}

#[test]
fn a_realm_holds_several_roots_each_with_its_own_tree() {
    let mut forest = standard_forest();
    let platform = root(&mut forest, "platform");
    let research = root(&mut forest, "research");
    let prod = child(&mut forest, platform, "prod");

    assert_eq!(forest.roots(), {
        let mut expected = vec![platform, research];
        expected.sort();
        expected
    });
    assert_eq!(forest.children(platform), vec![prod]);
    assert_eq!(forest.children(research), Vec::new());
    assert_eq!(forest.path(prod).expect("path"), "platform/prod");
    assert_eq!(forest.depth(prod).expect("depth"), 2);
    assert_eq!(forest.ancestors(prod).expect("ancestors"), vec![platform]);
    assert!(forest.assert_acyclic().is_ok());
}

#[test]
fn a_domain_from_another_realm_is_refused() {
    let mut forest = standard_forest();
    let elsewhere = Realm::standard(None, ProjectId::new());
    let stranger = AccessDomain::root(
        AccessDomainId::new(),
        elsewhere,
        "platform",
        "Platform",
        now(),
    )
    .expect("valid node");
    assert!(matches!(
        forest.insert(stranger),
        Err(DomainError::AccessDomainRealmMismatch(_))
    ));
}

#[test]
fn a_domain_cannot_be_moved_to_another_realm() {
    let mut origin = standard_forest();
    let platform = root(&mut origin, "platform");
    let prod = child(&mut origin, platform, "prod");
    let mut destination = standard_forest();

    let lifted = origin.remove_subtree(platform).expect("subtree removes");
    assert_eq!(lifted.len(), 2);
    assert!(origin.is_empty());
    for domain in lifted {
        assert!(
            matches!(
                destination.insert(domain),
                Err(DomainError::AccessDomainRealmMismatch(_))
            ),
            "a lifted domain must not be admitted by another realm"
        );
    }
    assert!(destination.is_empty());
    assert!(!destination.contains(prod));
}

#[test]
fn siblings_cannot_share_a_slug_but_cousins_can() {
    let mut forest = standard_forest();
    let platform = root(&mut forest, "platform");
    let research = root(&mut forest, "research");
    child(&mut forest, platform, "prod");

    assert!(matches!(
        forest.create_child(AccessDomainId::new(), platform, "prod", "Prod", now()),
        Err(DomainError::AccessDomainConflict(_))
    ));
    assert!(forest
        .create_child(AccessDomainId::new(), research, "prod", "Prod", now())
        .is_ok());
    assert!(matches!(
        forest.create_root(AccessDomainId::new(), "platform", "Platform", now()),
        Err(DomainError::AccessDomainConflict(_))
    ));
}

#[test]
fn renaming_respects_sibling_uniqueness_and_leaves_the_path_readable() {
    let mut forest = standard_forest();
    let platform = root(&mut forest, "platform");
    let prod = child(&mut forest, platform, "prod");
    child(&mut forest, platform, "staging");

    assert!(matches!(
        forest.rename(prod, "staging", "Staging"),
        Err(DomainError::AccessDomainConflict(_))
    ));
    assert!(forest.rename(prod, "production", "Production").is_ok());
    assert_eq!(forest.path(prod).expect("path"), "platform/production");
    assert!(forest.rename(prod, "production", "Production EU").is_ok());
}

#[test]
fn depth_is_capped_on_insert_and_on_movement() {
    let mut forest = standard_forest();
    let mut deepest = root(&mut forest, "level-1");
    for level in 2..=MAX_DOMAIN_DEPTH {
        deepest = child(&mut forest, deepest, &format!("level-{level}"));
    }
    assert_eq!(forest.depth(deepest).expect("depth"), MAX_DOMAIN_DEPTH);
    assert!(matches!(
        forest.create_child(AccessDomainId::new(), deepest, "over", "Over", now()),
        Err(DomainError::AccessDomainDepthExceeded(_))
    ));

    let other = root(&mut forest, "other");
    let branch = child(&mut forest, other, "branch");
    assert!(
        matches!(
            forest.reparent(branch, Some(deepest)),
            Err(DomainError::AccessDomainDepthExceeded(_))
        ),
        "a subtree's whole height counts against the cap"
    );
}

#[test]
fn reparenting_into_your_own_subtree_is_a_cycle() {
    let mut forest = standard_forest();
    let platform = root(&mut forest, "platform");
    let prod = child(&mut forest, platform, "prod");
    let eu = child(&mut forest, prod, "eu");

    assert!(matches!(
        forest.reparent(platform, Some(eu)),
        Err(DomainError::AccessDomainCycle(_))
    ));
    assert!(matches!(
        forest.reparent(platform, Some(platform)),
        Err(DomainError::AccessDomainCycle(_))
    ));
    assert!(forest.assert_acyclic().is_ok());
    assert_eq!(forest.path(eu).expect("path"), "platform/prod/eu");
}

#[test]
fn a_legal_move_rewrites_the_path_and_keeps_the_vault_binding() {
    let mut forest = standard_forest();
    let realm = forest.realm();
    let platform = root(&mut forest, "platform");
    let research = root(&mut forest, "research");
    let binding = VaultBinding::bind(&realm, VaultId::new());
    let prod = AccessDomain::child(
        AccessDomainId::new(),
        realm,
        platform,
        "prod",
        "Prod",
        now(),
    )
    .expect("valid node")
    .with_vault_binding(binding)
    .expect("binding matches the realm");
    let prod_id = prod.id();
    forest.insert(prod).expect("child inserts");

    forest.reparent(prod_id, Some(research)).expect("moves");
    assert_eq!(forest.path(prod_id).expect("path"), "research/prod");
    assert_eq!(
        forest
            .require(prod_id)
            .expect("still here")
            .vault_binding()
            .expect("still bound")
            .project_id,
        realm.project_id,
        "a move inside the realm cannot change the project a vault is sealed against"
    );

    forest.reparent(prod_id, None).expect("promotes to a root");
    assert!(forest.require(prod_id).expect("still here").is_root());
    assert_eq!(forest.path(prod_id).expect("path"), "prod");
}

#[test]
fn a_parent_is_removed_with_its_children_or_not_at_all() {
    let mut forest = standard_forest();
    let platform = root(&mut forest, "platform");
    let prod = child(&mut forest, platform, "prod");
    child(&mut forest, prod, "eu");

    assert!(matches!(
        forest.remove_leaf(platform),
        Err(DomainError::AccessDomainConflict(_))
    ));
    let removed = forest.remove_subtree(platform).expect("subtree removes");
    assert_eq!(removed.len(), 3);
    assert_eq!(
        removed.first().map(AccessDomain::slug),
        Some("eu"),
        "deepest first, so the forest is valid after each single removal"
    );
    assert!(forest.is_empty());
}

#[test]
fn nothing_permanent_hangs_under_something_temporary() {
    let mut forest = standard_forest();
    let realm = forest.realm();
    let visit = AccessDomain::root(AccessDomainId::new(), realm, "visit", "Visit", now())
        .expect("valid node")
        .with_lifetime(DomainLifetime::Temporary {
            expires_at: now() + Duration::days(2),
        })
        .expect("sane lifetime");
    let visit_id = visit.id();
    forest.insert(visit).expect("root inserts");

    assert!(matches!(
        forest.create_child(AccessDomainId::new(), visit_id, "forever", "Forever", now()),
        Err(DomainError::AccessDomainLifetime(_))
    ));

    let outliving = AccessDomain::child(
        AccessDomainId::new(),
        realm,
        visit_id,
        "later",
        "Later",
        now(),
    )
    .expect("valid node")
    .with_lifetime(DomainLifetime::Temporary {
        expires_at: now() + Duration::days(3),
    })
    .expect("sane lifetime");
    assert!(matches!(
        forest.insert(outliving),
        Err(DomainError::AccessDomainLifetime(_))
    ));
}

#[test]
fn an_expired_ancestor_takes_its_subtree_with_it() {
    let mut forest = standard_forest();
    let realm = forest.realm();
    let deadline = now() + Duration::days(2);
    let visit = AccessDomain::root(AccessDomainId::new(), realm, "visit", "Visit", now())
        .expect("valid node")
        .with_lifetime(DomainLifetime::Temporary {
            expires_at: deadline,
        })
        .expect("sane lifetime");
    let visit_id = visit.id();
    forest.insert(visit).expect("root inserts");
    let inner = AccessDomain::child(
        AccessDomainId::new(),
        realm,
        visit_id,
        "inner",
        "Inner",
        now(),
    )
    .expect("valid node")
    .with_lifetime(DomainLifetime::Temporary {
        expires_at: now() + Duration::days(1),
    })
    .expect("sane lifetime");
    let inner_id = inner.id();
    forest.insert(inner).expect("child inserts");
    let keeper = root(&mut forest, "keeper");

    assert_eq!(forest.deadlines().len(), 2);
    assert!(forest.assert_reachable(inner_id, now()).is_ok());
    assert_eq!(
        forest.assert_reachable(inner_id, now() + Duration::days(3)),
        Err(DomainError::AccessDomainExpired),
        "a child with its own later reading is still unreachable under a spent parent"
    );

    let pruned = forest
        .prune_expired(now() + Duration::days(3))
        .expect("prunes");
    assert_eq!(pruned.len(), 2);
    assert_eq!(forest.roots(), vec![keeper]);
}

#[test]
fn a_lifetime_cannot_be_stretched_past_a_child_or_a_parent() {
    let mut forest = standard_forest();
    let realm = forest.realm();
    let outer = AccessDomain::root(AccessDomainId::new(), realm, "outer", "Outer", now())
        .expect("valid node")
        .with_lifetime(DomainLifetime::Temporary {
            expires_at: now() + Duration::days(4),
        })
        .expect("sane lifetime");
    let outer_id = outer.id();
    forest.insert(outer).expect("root inserts");
    let inner = AccessDomain::child(
        AccessDomainId::new(),
        realm,
        outer_id,
        "inner",
        "Inner",
        now(),
    )
    .expect("valid node")
    .with_lifetime(DomainLifetime::Temporary {
        expires_at: now() + Duration::days(2),
    })
    .expect("sane lifetime");
    let inner_id = inner.id();
    forest.insert(inner).expect("child inserts");

    let shortened = forest.set_lifetime(
        outer_id,
        DomainLifetime::Temporary {
            expires_at: now() + Duration::days(1),
        },
    );
    assert!(
        matches!(shortened, Err(DomainError::AccessDomainLifetime(_))),
        "shortening a parent past its child would orphan the child"
    );
    assert!(matches!(
        forest.set_lifetime(inner_id, DomainLifetime::Permanent),
        Err(DomainError::AccessDomainLifetime(_))
    ));
    assert!(forest
        .set_lifetime(
            inner_id,
            DomainLifetime::Temporary {
                expires_at: now() + Duration::days(4),
            },
        )
        .is_ok());
}

#[test]
fn a_personal_realm_still_nests_domains() {
    let mut forest = AccessDomainForest::new(Realm::personal(ProjectId::new()));
    assert_eq!(forest.realm().project_kind, ProjectKind::Personal);
    let home = root(&mut forest, "home");
    let taxes = child(&mut forest, home, "taxes");
    assert_eq!(forest.path(taxes).expect("path"), "home/taxes");
    assert!(forest.assert_acyclic().is_ok());
}
