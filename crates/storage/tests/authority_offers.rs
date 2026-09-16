//! Grant-offer activation fences (`migrations/0034` + `0038` roster digest).
//!
//! Snapshot offers require a reviewed roster digest; live offers are refused
//! until a trusted-writer advance path exists. Cap and one-person uniqueness
//! stay database-enforced.

mod authority_support;

use authority_support::{entry, issue, seed_grant, seed_realm};
use opensesame_storage::authority::{
    ActivationOutcome, NewGrantOffer, OfferActivation,
};
use opensesame_storage::Db;

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
            roster_digest: Some("sha256:reviewed-roster"),
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
async fn a_snapshot_offer_without_a_roster_digest_is_refused() {
    let db = Db::connect_memory().await.unwrap();
    let (organization_id, domain_id) = seed_realm(&db, "org:one").await;
    seed_grant(&db, &organization_id, "grant:envelope").await;
    db.issue_authority(
        &issue("grant:envelope", &organization_id, &domain_id),
        &[entry("resource:A", "read")],
    )
    .await
    .unwrap();
    assert!(
        !db.create_grant_offer(&NewGrantOffer {
            id: "offer:no-digest",
            organization_id: &organization_id,
            domain_id: &domain_id,
            cohort_id: "cohort:raid",
            cohort_revision: 1,
            membership_binding: "snapshot",
            roster_digest: None,
            envelope_grant_id: "grant:envelope",
            max_activations: 1,
        })
        .await
        .unwrap(),
        "a snapshot without a digest is not a reviewed roster"
    );
    assert!(
        !db.create_grant_offer(&NewGrantOffer {
            id: "offer:empty-digest",
            organization_id: &organization_id,
            domain_id: &domain_id,
            cohort_id: "cohort:raid",
            cohort_revision: 1,
            membership_binding: "snapshot",
            roster_digest: Some(""),
            envelope_grant_id: "grant:envelope",
            max_activations: 1,
        })
        .await
        .unwrap(),
        "an empty digest is not a reviewed roster"
    );
}

#[tokio::test]
async fn a_live_offer_is_refused_until_a_writer_path_exists() {
    let db = Db::connect_memory().await.unwrap();
    let (organization_id, domain_id) = seed_realm(&db, "org:one").await;
    seed_grant(&db, &organization_id, "grant:envelope").await;
    db.issue_authority(
        &issue("grant:envelope", &organization_id, &domain_id),
        &[entry("resource:A", "read")],
    )
    .await
    .unwrap();
    assert!(
        !db.create_grant_offer(&NewGrantOffer {
            id: "offer:live",
            organization_id: &organization_id,
            domain_id: &domain_id,
            cohort_id: "cohort:raid",
            cohort_revision: 1,
            membership_binding: "live",
            roster_digest: None,
            envelope_grant_id: "grant:envelope",
            max_activations: 1,
        })
        .await
        .unwrap(),
        "live binding must not freeze a revision under a live label"
    );
}
