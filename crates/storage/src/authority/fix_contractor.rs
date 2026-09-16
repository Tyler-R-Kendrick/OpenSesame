//! FIX-CONTRACTOR — engagement isolation on the durable grant ledger.
//!
//! Correlated permission math and snapshot admission live in
//! `opensesame-domain::fix_contractor`. Here we persist the correlated
//! entries, fence an ancestor without waiting for a projection writer, and
//! show an independent root grant surviving engagement end.

use chrono::{Duration, Utc};

use super::fix_support::{entry, issue, seed_grant, seed_realm};
use crate::Db;

#[tokio::test]
async fn fix_contractor_correlated_entries_do_not_recombine() {
    let db = Db::connect_memory().await.unwrap();
    let (organization_id, domain_id) = seed_realm(&db, "org:contractor").await;
    seed_grant(&db, &organization_id, "grant:eng").await;
    assert!(db
        .issue_authority(
            &issue("grant:eng", &organization_id, &domain_id),
            &[
                entry("resource:A", "logs.read"),
                entry("resource:B", "ticket.comment"),
            ],
        )
        .await
        .unwrap());

    let held = db
        .fenced_authority(&organization_id, "grant:eng", Utc::now())
        .await
        .unwrap()
        .expect("engagement grant must be live");
    let allows = |action: &str, resource: &str| {
        held.entries.iter().any(|e| {
            e.resource_selector == resource
                && e.action_set_json.contains(&format!("\"{action}\""))
        })
    };
    assert!(allows("logs.read", "resource:A"));
    assert!(allows("ticket.comment", "resource:B"));
    assert!(
        !allows("logs.write", "resource:A"),
        "logs.read A + ticket.comment B must not become logs.write A"
    );
    assert!(
        !allows("ticket.comment", "resource:A"),
        "ticket.comment stays bound to B"
    );
}

#[tokio::test]
async fn fix_contractor_snapshot_roster_add_is_denied_at_offer() {
    let db = Db::connect_memory().await.unwrap();
    let (organization_id, domain_id) = seed_realm(&db, "org:contractor").await;
    seed_grant(&db, &organization_id, "grant:envelope").await;
    assert!(db
        .issue_authority(
            &issue("grant:envelope", &organization_id, &domain_id),
            &[entry("resource:A", "logs.read")],
        )
        .await
        .unwrap());
    assert!(db
        .create_grant_offer(&super::NewGrantOffer {
            id: "offer:eng",
            organization_id: &organization_id,
            domain_id: &domain_id,
            cohort_id: "cohort:contractors",
            cohort_revision: 3,
            membership_binding: "snapshot",
            roster_digest: Some("sha256:contractors-rev3"),
            envelope_grant_id: "grant:envelope",
            max_activations: 4,
        })
        .await
        .unwrap());

    seed_grant(&db, &organization_id, "grant:late").await;
    assert!(db
        .issue_authority(
            &issue("grant:late", &organization_id, &domain_id),
            &[entry("resource:A", "logs.read")],
        )
        .await
        .unwrap());

    // A third contractor added after snapshot approval presents a newer roster
    // revision. The offer was reviewed against 3; 4 must refuse.
    let late = db
        .activate_grant_offer(&super::OfferActivation {
            offer_id: "offer:eng",
            organization_id: &organization_id,
            beneficiary_principal_id: "person:third",
            grant_id: "grant:late",
            cohort_revision: 4,
            membership_source: "roster:live-add",
            membership_issuer: "https://identity.example",
            idempotency_key: "claim:late",
        })
        .await
        .unwrap();
    assert_eq!(late, super::ActivationOutcome::Refused);
}

#[tokio::test]
async fn fix_contractor_ancestor_revoke_denies_descendant_without_projection() {
    let db = Db::connect_memory().await.unwrap();
    let (organization_id, domain_id) = seed_realm(&db, "org:contractor").await;
    seed_grant(&db, &organization_id, "grant:sponsor").await;
    seed_grant(&db, &organization_id, "grant:child").await;
    let sponsor = issue("grant:sponsor", &organization_id, &domain_id);
    assert!(db
        .issue_authority(
            &sponsor,
            &[entry("resource:A", "logs.read")],
        )
        .await
        .unwrap());
    let mut child = issue("grant:child", &organization_id, &domain_id);
    child.parent_grant_id = Some("grant:sponsor");
    child.issuance_basis = "delegation";
    child.delegation_depth_remaining = 0;
    child.not_before = sponsor.not_before + Duration::seconds(1);
    child.expires_at = sponsor.expires_at - Duration::seconds(1);
    assert!(db
        .issue_authority(&child, &[entry("resource:A", "logs.read")])
        .await
        .unwrap());
    assert!(db
        .fenced_authority(&organization_id, "grant:child", Utc::now())
        .await
        .unwrap()
        .is_some());

    // No projection writer is running. The fence alone must stop the child.
    db.fence_grant("grant:sponsor", "owner-revoked", Utc::now())
        .await
        .unwrap();
    assert!(
        db.fenced_authority(&organization_id, "grant:child", Utc::now())
            .await
            .unwrap()
            .is_none(),
        "ancestor revoke must deny the descendant on the next read"
    );
}

#[tokio::test]
async fn fix_contractor_independent_grant_survives_engagement_end() {
    let db = Db::connect_memory().await.unwrap();
    let (organization_id, domain_id) = seed_realm(&db, "org:contractor").await;
    seed_grant(&db, &organization_id, "grant:engagement").await;
    seed_grant(&db, &organization_id, "grant:independent").await;
    assert!(db
        .issue_authority(
            &issue("grant:engagement", &organization_id, &domain_id),
            &[entry("resource:A", "logs.read")],
        )
        .await
        .unwrap());
    assert!(db
        .issue_authority(
            &issue("grant:independent", &organization_id, &domain_id),
            &[entry("resource:docs", "read")],
        )
        .await
        .unwrap());

    db.fence_grant("grant:engagement", "engagement-ended", Utc::now())
        .await
        .unwrap();
    assert!(db
        .fenced_authority(&organization_id, "grant:engagement", Utc::now())
        .await
        .unwrap()
        .is_none());
    assert!(
        db.fenced_authority(&organization_id, "grant:independent", Utc::now())
            .await
            .unwrap()
            .is_some(),
        "ending the engagement must not destroy an unrelated root grant"
    );
}
