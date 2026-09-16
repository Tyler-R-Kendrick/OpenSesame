//! Control inheritance, delegation, and the personal-realm refusal.

use super::{
    AccessDomainForest, ControlAssignment, ControlIndex, ControlScope, DomainRole, InheritanceMode,
    Realm,
};
use crate::{AccessDomainId, DomainControlId, DomainError, PrincipalId, ProjectId};
use chrono::{DateTime, Utc};

fn now() -> DateTime<Utc> {
    DateTime::parse_from_rfc3339("2026-03-01T00:00:00Z")
        .expect("fixture timestamp")
        .with_timezone(&Utc)
}

fn assignment(
    domain_id: AccessDomainId,
    principal_id: PrincipalId,
    role: DomainRole,
    scope: ControlScope,
) -> ControlAssignment {
    ControlAssignment {
        id: DomainControlId::new(),
        domain_id,
        principal_id,
        role,
        scope,
    }
}

/// A two-level estate: `platform` with `prod` and `staging` beneath it.
fn estate(
    realm: Realm,
) -> (
    AccessDomainForest,
    AccessDomainId,
    AccessDomainId,
    AccessDomainId,
) {
    let mut forest = AccessDomainForest::new(realm);
    let platform = forest
        .create_root(AccessDomainId::new(), "platform", "Platform", now())
        .expect("root inserts");
    let prod = forest
        .create_child(AccessDomainId::new(), platform, "prod", "Prod", now())
        .expect("child inserts");
    let staging = forest
        .create_child(AccessDomainId::new(), platform, "staging", "Staging", now())
        .expect("child inserts");
    (forest, platform, prod, staging)
}

#[test]
fn subtree_control_reaches_down_and_domain_only_control_does_not() {
    let (forest, platform, prod, _) = estate(Realm::standard(None, ProjectId::new()));
    let wide = PrincipalId::new();
    let narrow = PrincipalId::new();
    let mut control = ControlIndex::new();
    control
        .insert(
            &forest,
            assignment(platform, wide, DomainRole::Admin, ControlScope::Subtree),
        )
        .expect("insert");
    control
        .insert(
            &forest,
            assignment(
                platform,
                narrow,
                DomainRole::Owner,
                ControlScope::DomainOnly,
            ),
        )
        .expect("insert");

    let inherited = control
        .effective_control(&forest, prod, wide)
        .expect("resolves")
        .expect("reaches prod");
    assert_eq!(inherited.role, DomainRole::Admin);
    assert_eq!(inherited.domain_id, prod);
    assert_eq!(
        inherited.source_domain_id, platform,
        "provenance names the domain the grant was made at, so it can be revoked"
    );

    assert!(
        control
            .effective_control(&forest, prod, narrow)
            .expect("resolves")
            .is_none(),
        "domain-only control stays where it was granted"
    );
    assert_eq!(
        control
            .effective_control(&forest, platform, narrow)
            .expect("resolves")
            .map(|held| held.role),
        Some(DomainRole::Owner)
    );
}

#[test]
fn an_isolated_domain_stops_the_walk_at_itself() {
    let (mut forest, platform, prod, staging) = estate(Realm::standard(None, ProjectId::new()));
    let deep = forest
        .create_child(AccessDomainId::new(), prod, "eu", "EU", now())
        .expect("child inserts");
    forest
        .set_inheritance(prod, InheritanceMode::Isolated)
        .expect("isolates");

    let principal = PrincipalId::new();
    let mut control = ControlIndex::new();
    control
        .insert(
            &forest,
            assignment(
                platform,
                principal,
                DomainRole::Owner,
                ControlScope::Subtree,
            ),
        )
        .expect("insert");

    assert!(control
        .effective_control(&forest, prod, principal)
        .expect("resolves")
        .is_none());
    assert!(
        control
            .effective_control(&forest, deep, principal)
            .expect("resolves")
            .is_none(),
        "isolation covers the branch, not just the isolated node"
    );
    assert!(control
        .effective_control(&forest, staging, principal)
        .expect("resolves")
        .is_some());
}

#[test]
fn the_strongest_applicable_role_wins() {
    let (forest, platform, prod, _) = estate(Realm::standard(None, ProjectId::new()));
    let principal = PrincipalId::new();
    let mut control = ControlIndex::new();
    control
        .insert(
            &forest,
            assignment(
                platform,
                principal,
                DomainRole::Member,
                ControlScope::Subtree,
            ),
        )
        .expect("insert");
    control
        .insert(
            &forest,
            assignment(prod, principal, DomainRole::Owner, ControlScope::DomainOnly),
        )
        .expect("insert");

    let held = control
        .effective_control(&forest, prod, principal)
        .expect("resolves")
        .expect("holds control");
    assert_eq!(held.role, DomainRole::Owner);
    assert_eq!(held.source_domain_id, prod);
}

#[test]
fn control_at_a_domain_is_recorded_once_per_principal() {
    let (forest, platform, _, _) = estate(Realm::standard(None, ProjectId::new()));
    let principal = PrincipalId::new();
    let mut control = ControlIndex::new();
    let first = assignment(
        platform,
        principal,
        DomainRole::Member,
        ControlScope::Subtree,
    );
    control.insert(&forest, first).expect("insert");
    assert!(matches!(
        control.insert(
            &forest,
            assignment(
                platform,
                principal,
                DomainRole::Owner,
                ControlScope::Subtree
            ),
        ),
        Err(DomainError::AccessDomainConflict(_))
    ));
    assert!(matches!(
        control.insert(&forest, first),
        Err(DomainError::AccessDomainConflict(_))
    ));
    assert_eq!(control.len(), 1);
    assert!(control.remove(first.id).is_some());
    assert!(control.is_empty());
}

#[test]
fn delegation_never_widens_authority() {
    let (forest, platform, prod, _) = estate(Realm::standard(None, ProjectId::new()));
    let admin = PrincipalId::new();
    let member = PrincipalId::new();
    let mut control = ControlIndex::new();
    control
        .insert(
            &forest,
            assignment(platform, admin, DomainRole::Admin, ControlScope::Subtree),
        )
        .expect("insert");
    control
        .insert(
            &forest,
            assignment(platform, member, DomainRole::Member, ControlScope::Subtree),
        )
        .expect("insert");

    let newcomer = PrincipalId::new();
    assert!(
        matches!(
            control.insert_delegated(
                &forest,
                admin,
                assignment(prod, newcomer, DomainRole::Owner, ControlScope::Subtree),
            ),
            Err(DomainError::AccessDomainControlWiden(_))
        ),
        "an admin cannot mint an owner beneath themselves"
    );
    assert!(
        matches!(
            control.insert_delegated(
                &forest,
                member,
                assignment(prod, newcomer, DomainRole::Member, ControlScope::Subtree),
            ),
            Err(DomainError::AccessDomainControlWiden(_))
        ),
        "a member administers nothing"
    );
    assert!(
        matches!(
            control.insert_delegated(
                &forest,
                PrincipalId::new(),
                assignment(prod, newcomer, DomainRole::Member, ControlScope::Subtree),
            ),
            Err(DomainError::AccessDomainControlWiden(_))
        ),
        "a stranger holds nothing to delegate"
    );
    assert!(control
        .insert_delegated(
            &forest,
            admin,
            assignment(prod, newcomer, DomainRole::Admin, ControlScope::Subtree),
        )
        .is_ok());
}

#[test]
fn administering_requires_an_administering_role() {
    let (forest, platform, prod, _) = estate(Realm::standard(None, ProjectId::new()));
    let member = PrincipalId::new();
    let owner = PrincipalId::new();
    let mut control = ControlIndex::new();
    control
        .insert(
            &forest,
            assignment(platform, member, DomainRole::Member, ControlScope::Subtree),
        )
        .expect("insert");
    control
        .insert(
            &forest,
            assignment(platform, owner, DomainRole::Owner, ControlScope::Subtree),
        )
        .expect("insert");

    assert!(matches!(
        control.assert_may_administer(&forest, prod, member),
        Err(DomainError::AuthorizationDenied(_))
    ));
    assert!(matches!(
        control.assert_may_administer(&forest, prod, PrincipalId::new()),
        Err(DomainError::AuthorizationDenied(_))
    ));
    assert_eq!(
        control
            .assert_may_administer(&forest, prod, owner)
            .expect("owner administers")
            .role,
        DomainRole::Owner
    );
}

#[test]
fn a_personal_realm_refuses_a_second_controlling_principal() {
    let (forest, platform, prod, _) = estate(Realm::personal(ProjectId::new()));
    let me = PrincipalId::new();
    let mut control = ControlIndex::new();
    control
        .insert(
            &forest,
            assignment(platform, me, DomainRole::Owner, ControlScope::Subtree),
        )
        .expect("my own estate");
    control
        .insert(
            &forest,
            assignment(prod, me, DomainRole::Owner, ControlScope::Subtree),
        )
        .expect("still just me");

    let someone_else = PrincipalId::new();
    assert!(matches!(
        control.insert(
            &forest,
            assignment(
                prod,
                someone_else,
                DomainRole::Member,
                ControlScope::DomainOnly
            ),
        ),
        Err(DomainError::AccessDomainPersonalSharing(_))
    ));
    assert!(
        matches!(
            control.insert_delegated(
                &forest,
                me,
                assignment(
                    prod,
                    someone_else,
                    DomainRole::Member,
                    ControlScope::Subtree
                ),
            ),
            Err(DomainError::AccessDomainPersonalSharing(_))
        ),
        "delegating inside a personal project is the same refusal"
    );
}

#[test]
fn control_is_refused_for_a_domain_that_is_not_in_the_forest() {
    let (forest, _, _, _) = estate(Realm::standard(None, ProjectId::new()));
    let mut control = ControlIndex::new();
    assert!(matches!(
        control.insert(
            &forest,
            assignment(
                AccessDomainId::new(),
                PrincipalId::new(),
                DomainRole::Owner,
                ControlScope::Subtree,
            ),
        ),
        Err(DomainError::AccessDomainNotFound(_))
    ));
}

#[test]
fn the_role_ladder_is_a_ladder() {
    assert!(DomainRole::Owner.covers(DomainRole::Admin));
    assert!(DomainRole::Admin.covers(DomainRole::Member));
    assert!(DomainRole::Member.covers(DomainRole::Member));
    assert!(!DomainRole::Member.covers(DomainRole::Admin));
    assert!(!DomainRole::Admin.covers(DomainRole::Owner));
    assert!(DomainRole::Admin.can_administer());
    assert!(!DomainRole::Member.can_administer());
    assert!(DomainRole::Owner.can_transfer_ownership());
    assert!(!DomainRole::Admin.can_transfer_ownership());
}
