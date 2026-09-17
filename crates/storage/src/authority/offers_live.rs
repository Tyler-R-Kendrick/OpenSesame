//! Live grant-offer writer path (COH-LIVE) on the Host store.

use chrono::Duration;

use super::fix_support::{entry, issue, seed_grant, seed_realm};
use super::{ActivationOutcome, NewGrantOffer, OfferActivation};
use crate::Db;

#[tokio::test]
async fn live_offer_without_a_trusted_writer_is_refused() {
    let db = Db::connect_memory().await.unwrap();
    let (organization_id, domain_id) = seed_realm(&db, "org:live").await;
    seed_grant(&db, &organization_id, "grant:envelope").await;
    assert!(db
        .issue_authority(
            &issue("grant:envelope", &organization_id, &domain_id),
            &[entry("resource:A", "read")],
        )
        .await
        .unwrap());
    assert!(
        !db.create_grant_offer(&NewGrantOffer {
            id: "offer:live",
            organization_id: &organization_id,
            domain_id: &domain_id,
            cohort_id: "cohort:raid",
            cohort_revision: 1,
            membership_binding: "live",
            roster_digest: None,
            trusted_writer: None,
            permitted_principal_class: None,
            envelope_grant_id: "grant:envelope",
            max_activations: 1,
        })
        .await
        .unwrap(),
        "live binding needs a writer"
    );
}

#[tokio::test]
async fn live_offer_admits_trusted_writer_and_refuses_unauthorized() {
    let db = Db::connect_memory().await.unwrap();
    let (organization_id, domain_id) = seed_realm(&db, "org:live").await;
    seed_grant(&db, &organization_id, "grant:envelope").await;
    let envelope = issue("grant:envelope", &organization_id, &domain_id);
    assert!(db
        .issue_authority(&envelope, &[entry("resource:A", "read")])
        .await
        .unwrap());
    assert!(db
        .create_grant_offer(&NewGrantOffer {
            id: "offer:live",
            organization_id: &organization_id,
            domain_id: &domain_id,
            cohort_id: "cohort:raid",
            cohort_revision: 1,
            membership_binding: "live",
            roster_digest: None,
            trusted_writer: Some("writer:sponsor"),
            permitted_principal_class: Some("raider"),
            envelope_grant_id: "grant:envelope",
            max_activations: 2,
        })
        .await
        .unwrap());

    seed_grant(&db, &organization_id, "grant:alice").await;
    seed_grant(&db, &organization_id, "grant:mallory").await;
    let mut alice = issue("grant:alice", &organization_id, &domain_id);
    alice.parent_grant_id = Some("grant:envelope");
    alice.issuance_basis = "delegation";
    alice.delegation_depth_remaining = 0;
    alice.not_before = envelope.not_before + Duration::seconds(1);
    alice.expires_at = envelope.expires_at - Duration::seconds(1);
    assert!(db
        .issue_authority(&alice, &[entry("resource:A", "read")])
        .await
        .unwrap());
    assert!(db
        .issue_authority(
            &issue("grant:mallory", &organization_id, &domain_id),
            &[entry("resource:A", "read")],
        )
        .await
        .unwrap());

    let outsider = OfferActivation {
        offer_id: "offer:live",
        organization_id: &organization_id,
        beneficiary_principal_id: "person:mallory",
        grant_id: "grant:mallory",
        cohort_revision: 2,
        membership_source: "raider",
        membership_issuer: "writer:nobody",
        idempotency_key: "claim:m",
    };
    assert_eq!(
        db.activate_grant_offer(&outsider).await.unwrap(),
        ActivationOutcome::Refused
    );

    let late = OfferActivation {
        offer_id: "offer:live",
        organization_id: &organization_id,
        beneficiary_principal_id: "person:alice",
        grant_id: "grant:alice",
        cohort_revision: 4,
        membership_source: "raider",
        membership_issuer: "writer:sponsor",
        idempotency_key: "claim:a",
    };
    assert_eq!(
        db.activate_grant_offer(&late).await.unwrap(),
        ActivationOutcome::Bound
    );
}

#[tokio::test]
async fn a_broader_unrelated_grant_cannot_be_bound_to_an_offer() {
    let db = Db::connect_memory().await.unwrap();
    let (organization_id, domain_id) = seed_realm(&db, "org:live").await;
    seed_grant(&db, &organization_id, "grant:envelope").await;
    assert!(db
        .issue_authority(
            &issue("grant:envelope", &organization_id, &domain_id),
            &[entry("resource:A", "read")],
        )
        .await
        .unwrap());
    assert!(db
        .create_grant_offer(&NewGrantOffer {
            id: "offer:live",
            organization_id: &organization_id,
            domain_id: &domain_id,
            cohort_id: "cohort:raid",
            cohort_revision: 1,
            membership_binding: "live",
            roster_digest: None,
            trusted_writer: Some("writer:sponsor"),
            permitted_principal_class: None,
            envelope_grant_id: "grant:envelope",
            max_activations: 2,
        })
        .await
        .unwrap());

    seed_grant(&db, &organization_id, "grant:wide").await;
    assert!(db
        .issue_authority(
            &issue("grant:wide", &organization_id, &domain_id),
            &[entry("resource:A", "read"), entry("resource:A", "write")],
        )
        .await
        .unwrap());

    let wide = OfferActivation {
        offer_id: "offer:live",
        organization_id: &organization_id,
        beneficiary_principal_id: "person:wide",
        grant_id: "grant:wide",
        cohort_revision: 1,
        membership_source: "raider",
        membership_issuer: "writer:sponsor",
        idempotency_key: "claim:wide",
    };
    assert_eq!(
        db.activate_grant_offer(&wide).await.unwrap(),
        ActivationOutcome::Refused,
        "an independent broader root cannot ride the offer envelope"
    );
}
