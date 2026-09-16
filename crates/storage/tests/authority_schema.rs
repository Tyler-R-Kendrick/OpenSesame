//! The realm boundary and the correlated-entry shape, as the database enforces
//! them (`migrations/0034_general_authority.sql`).
//!
//! Each test here is one of the adversarial cases the storage swarm was asked to
//! answer: a parent in another realm, a domain that outlives its own termination,
//! a permission list that recombines into a right nobody granted, an offer spent
//! twice, and a grant that got its authority without a domain.

mod authority_support;

use authority_support::{entry, issue, seed_grant, seed_realm};
use chrono::{Duration, Utc};
use opensesame_storage::authority::{
    ActivationOutcome, AuthorityIssue, DomainReparent, NewAccessDomain, NewGrantOffer,
    OfferActivation, PermissionEntry,
};
use opensesame_storage::Db;

#[tokio::test]
async fn a_domain_cannot_take_a_parent_from_another_realm() {
    let db = Db::connect_memory().await.unwrap();
    seed_realm(&db, "org:one").await;
    seed_realm(&db, "org:two").await;
    db.create_access_domain(&NewAccessDomain {
        id: "dom:one",
        organization_id: "org:one",
        parent_id: None,
        project_id: None,
    })
    .await
    .unwrap();

    // The parent exists — in the other realm. The lookup is keyed on the pair, so
    // there is nothing to find and nothing to authorize.
    let crossed = db
        .create_access_domain(&NewAccessDomain {
            id: "dom:crossed",
            organization_id: "org:two",
            parent_id: Some("dom:one"),
            project_id: None,
        })
        .await
        .unwrap();
    assert!(!crossed, "a cross-realm parent must not be writable");

    let reparent = db
        .create_access_domain(&NewAccessDomain {
            id: "dom:two",
            organization_id: "org:two",
            parent_id: None,
            project_id: None,
        })
        .await
        .unwrap();
    assert!(reparent);
    let moved = db
        .reparent_access_domain(&DomainReparent {
            organization_id: "org:two",
            id: "dom:two",
            expected_revision: 1,
            new_parent_id: Some("dom:one"),
        })
        .await
        .unwrap();
    assert!(!moved, "a cross-realm reparent must not be writable either");
}

#[tokio::test]
async fn a_stale_revision_moves_nothing() {
    let db = Db::connect_memory().await.unwrap();
    seed_realm(&db, "org:one").await;
    for id in ["dom:a", "dom:b", "dom:c"] {
        db.create_access_domain(&NewAccessDomain {
            id,
            organization_id: "org:one",
            parent_id: None,
            project_id: None,
        })
        .await
        .unwrap();
    }
    let first = db
        .reparent_access_domain(&DomainReparent {
            organization_id: "org:one",
            id: "dom:c",
            expected_revision: 1,
            new_parent_id: Some("dom:a"),
        })
        .await
        .unwrap();
    assert!(first);

    // The second caller read revision 1, showed somebody an impact preview, and
    // lost the race. It must write nothing rather than move the domain again.
    let stale = db
        .reparent_access_domain(&DomainReparent {
            organization_id: "org:one",
            id: "dom:c",
            expected_revision: 1,
            new_parent_id: Some("dom:b"),
        })
        .await
        .unwrap();
    assert!(!stale);
    let domain = db.access_domain("org:one", "dom:c").await.unwrap().unwrap();
    assert_eq!(domain.parent_id.as_deref(), Some("dom:a"));
    assert_eq!(domain.revision, 2);
}

#[tokio::test]
async fn a_domain_cannot_be_moved_into_its_own_subtree() {
    let db = Db::connect_memory().await.unwrap();
    seed_realm(&db, "org:one").await;
    db.create_access_domain(&NewAccessDomain {
        id: "dom:root",
        organization_id: "org:one",
        parent_id: None,
        project_id: None,
    })
    .await
    .unwrap();
    db.create_access_domain(&NewAccessDomain {
        id: "dom:child",
        organization_id: "org:one",
        parent_id: Some("dom:root"),
        project_id: None,
    })
    .await
    .unwrap();

    let cycle = db
        .reparent_access_domain(&DomainReparent {
            organization_id: "org:one",
            id: "dom:root",
            expected_revision: 1,
            new_parent_id: Some("dom:child"),
        })
        .await
        .unwrap();
    assert!(!cycle, "a forest cannot contain a cycle");
}

#[tokio::test]
async fn entries_keep_their_correlation() {
    let db = Db::connect_memory().await.unwrap();
    let (organization_id, domain_id) = seed_realm(&db, "org:one").await;
    seed_grant(&db, &organization_id, "grant:one").await;
    let issued = db
        .issue_authority(
            &issue("grant:one", &organization_id, &domain_id),
            &[entry("resource:A", "read"), entry("resource:B", "write")],
        )
        .await
        .unwrap();
    assert!(issued);

    let entries = db
        .permission_entries(&organization_id, "grant:one")
        .await
        .unwrap();
    assert_eq!(entries.len(), 2);
    // (read, A) and (write, B) are stored as two rows. Nothing in the store pairs
    // the action of one with the resource of the other, so `write A` is not
    // reconstructible from what was persisted.
    let pairs: Vec<(String, String)> = entries
        .iter()
        .map(|entry| {
            (
                entry.resource_selector.clone(),
                entry.action_set_json.clone(),
            )
        })
        .collect();
    assert!(pairs.contains(&("resource:A".to_owned(), "[\"read\"]".to_owned())));
    assert!(pairs.contains(&("resource:B".to_owned(), "[\"write\"]".to_owned())));
    assert!(!pairs.contains(&("resource:A".to_owned(), "[\"write\"]".to_owned())));
}

#[tokio::test]
async fn authority_without_an_entry_is_refused() {
    let db = Db::connect_memory().await.unwrap();
    let (organization_id, domain_id) = seed_realm(&db, "org:one").await;
    seed_grant(&db, &organization_id, "grant:empty").await;
    let refused = db
        .issue_authority(
            &issue("grant:empty", &organization_id, &domain_id),
            &[] as &[PermissionEntry],
        )
        .await;
    assert!(
        refused.is_err(),
        "authority with no correlated right must not be recordable"
    );
}

#[tokio::test]
async fn authority_needs_an_active_domain_in_its_own_realm() {
    let db = Db::connect_memory().await.unwrap();
    let (organization_id, domain_id) = seed_realm(&db, "org:one").await;
    seed_realm(&db, "org:two").await;
    seed_grant(&db, &organization_id, "grant:one").await;

    let elsewhere = db
        .issue_authority(
            &issue("grant:one", "org:two", &domain_id),
            &[entry("resource:A", "read")],
        )
        .await
        .unwrap();
    assert!(!elsewhere, "the domain belongs to another realm");

    db.terminate_access_domain(&organization_id, &domain_id, 1)
        .await
        .unwrap();
    let terminated = db
        .issue_authority(
            &issue("grant:one", &organization_id, &domain_id),
            &[entry("resource:A", "read")],
        )
        .await
        .unwrap();
    assert!(!terminated, "a terminated domain issues nothing");
}

#[tokio::test]
async fn an_offer_admits_each_person_once_and_no_more_than_its_cap() {
    let db = Db::connect_memory().await.unwrap();
    let (organization_id, domain_id) = seed_realm(&db, "org:one").await;
    seed_grant(&db, &organization_id, "grant:envelope").await;
    db.issue_authority(
        &issue("grant:envelope", &organization_id, &domain_id),
        &[entry("resource:A", "read")],
    )
    .await
    .unwrap();
    assert!(db
        .create_grant_offer(&NewGrantOffer {
            id: "offer:one",
            organization_id: &organization_id,
            domain_id: &domain_id,
            cohort_id: "cohort:raid",
            cohort_revision: 7,
            membership_binding: "snapshot",
            envelope_grant_id: "grant:envelope",
            max_activations: 1,
        })
        .await
        .unwrap());

    // Each activation binds an individually issued grant — the FK on
    // `grant_offer_activations` refuses an activation that names authority nobody
    // recorded, which is the difference between an offer and a group token.
    for id in ["grant:one", "grant:two", "grant:three"] {
        seed_grant(&db, &organization_id, id).await;
        db.issue_authority(
            &issue(id, &organization_id, &domain_id),
            &[entry("resource:A", "read")],
        )
        .await
        .unwrap();
    }

    let bound = db
        .activate_grant_offer(&activation("person:one", "grant:one", "claim:1"))
        .await
        .unwrap();
    assert_eq!(bound, ActivationOutcome::Bound);

    // A redelivered claim is the same claim.
    let repeat = db
        .activate_grant_offer(&activation("person:one", "grant:one", "claim:1"))
        .await
        .unwrap();
    assert_eq!(repeat, ActivationOutcome::Duplicate);

    // A second person is inside the roster but outside the cap.
    let capped = db
        .activate_grant_offer(&activation("person:two", "grant:two", "claim:2"))
        .await
        .unwrap();
    assert_eq!(capped, ActivationOutcome::Refused);

    // And a claim quoting a roster revision the offer was not reviewed against
    // is refused rather than admitted under the current one.
    let mut stale = activation("person:three", "grant:three", "claim:3");
    stale.cohort_revision = 6;
    assert_eq!(
        db.activate_grant_offer(&stale).await.unwrap(),
        ActivationOutcome::Refused
    );
}

fn activation<'a>(
    principal: &'a str,
    grant_id: &'a str,
    idempotency_key: &'a str,
) -> OfferActivation<'a> {
    OfferActivation {
        offer_id: "offer:one",
        organization_id: "org:one",
        beneficiary_principal_id: principal,
        grant_id,
        cohort_revision: 7,
        membership_source: "roster:reviewed",
        membership_issuer: "https://identity.example",
        idempotency_key,
    }
}

#[tokio::test]
async fn a_child_window_cannot_outlast_its_parent() {
    let db = Db::connect_memory().await.unwrap();
    let (organization_id, domain_id) = seed_realm(&db, "org:one").await;
    seed_grant(&db, &organization_id, "grant:parent").await;
    seed_grant(&db, &organization_id, "grant:child").await;
    let mut parent = issue("grant:parent", &organization_id, &domain_id);
    parent.delegation_depth_remaining = 2;
    db.issue_authority(&parent, &[entry("resource:A", "read")])
        .await
        .unwrap();

    let longer = AuthorityIssue {
        grant_id: "grant:child",
        organization_id: &organization_id,
        domain_id: &domain_id,
        parent_grant_id: Some("grant:parent"),
        issuance_basis: "delegation",
        lineage_digest: "digest:lineage",
        policy_digest: "digest:policy",
        role_revision: None,
        offer_id: None,
        delegation_depth_remaining: 1,
        not_before: Utc::now(),
        expires_at: Utc::now() + Duration::hours(48),
        evidence_id: None,
    };
    assert!(
        !db.issue_authority(&longer, &[entry("resource:A", "read")])
            .await
            .unwrap(),
        "a child may not expire after its parent"
    );

    let mut same_depth = longer;
    same_depth.expires_at = Utc::now() + Duration::minutes(30);
    same_depth.delegation_depth_remaining = 2;
    assert!(
        !db.issue_authority(&same_depth, &[entry("resource:A", "read")])
            .await
            .unwrap(),
        "a child's delegation budget must strictly decrease"
    );
}
