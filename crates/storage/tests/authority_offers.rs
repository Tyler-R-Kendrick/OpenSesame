//! Grant-offer activation fences (`migrations/0034` + `0038` + `0039`).
//!
//! Snapshot offers require a reviewed roster digest and freeze that revision.
//! Live offers require a trusted writer, admit later revisions from that writer,
//! and refuse unauthorized issuers. Cap and one-person uniqueness stay
//! database-enforced.

mod authority_support;

use chrono::Utc;

use authority_support::{entry, issue, seed_grant, seed_realm};
use opensesame_storage::authority::{ActivationOutcome, NewGrantOffer, OfferActivation};
use opensesame_storage::Db;

#[tokio::test]
async fn an_offer_admits_each_person_once_and_no_more_than_its_cap() {
    let db = Db::connect_memory().await.unwrap();
    let (organization_id, domain_id) = seed_realm(&db, "org:one").await;
    seed_envelope(&db, &organization_id, &domain_id).await;
    assert!(db
        .create_grant_offer(&snapshot(
            "offer:one",
            &organization_id,
            &domain_id,
            7,
            Some("sha256:reviewed-roster"),
            1,
        ))
        .await
        .unwrap());

    for id in ["grant:one", "grant:two", "grant:three"] {
        seed_person(&db, &organization_id, &domain_id, id).await;
    }

    let bound = db
        .activate_grant_offer(&activation("person:one", "grant:one", "claim:1"))
        .await
        .unwrap();
    assert_eq!(bound, ActivationOutcome::Bound);

    let repeat = db
        .activate_grant_offer(&activation("person:one", "grant:one", "claim:1"))
        .await
        .unwrap();
    assert_eq!(repeat, ActivationOutcome::Duplicate);

    let capped = db
        .activate_grant_offer(&activation("person:two", "grant:two", "claim:2"))
        .await
        .unwrap();
    assert_eq!(capped, ActivationOutcome::Refused);

    let mut stale = activation("person:three", "grant:three", "claim:3");
    stale.cohort_revision = 6;
    assert_eq!(
        db.activate_grant_offer(&stale).await.unwrap(),
        ActivationOutcome::Refused
    );
}

#[tokio::test]
async fn a_snapshot_offer_without_a_roster_digest_is_refused() {
    let db = Db::connect_memory().await.unwrap();
    let (organization_id, domain_id) = seed_realm(&db, "org:one").await;
    seed_envelope(&db, &organization_id, &domain_id).await;
    assert!(
        !db.create_grant_offer(&snapshot(
            "offer:no-digest",
            &organization_id,
            &domain_id,
            1,
            None,
            1,
        ))
        .await
        .unwrap(),
        "a snapshot without a digest is not a reviewed roster"
    );
    assert!(
        !db.create_grant_offer(&snapshot(
            "offer:empty-digest",
            &organization_id,
            &domain_id,
            1,
            Some(""),
            1,
        ))
        .await
        .unwrap(),
        "an empty digest is not a reviewed roster"
    );
    let mut mixed = snapshot(
        "offer:mixed",
        &organization_id,
        &domain_id,
        1,
        Some("sha256:reviewed-roster"),
        1,
    );
    mixed.trusted_writer = Some("writer:sponsor");
    assert!(
        !db.create_grant_offer(&mixed).await.unwrap(),
        "a snapshot cannot also carry a live writer envelope"
    );
}

#[tokio::test]
async fn a_live_offer_without_a_trusted_writer_is_refused() {
    let db = Db::connect_memory().await.unwrap();
    let (organization_id, domain_id) = seed_realm(&db, "org:one").await;
    seed_envelope(&db, &organization_id, &domain_id).await;
    assert!(
        !db.create_grant_offer(&live(
            "offer:live",
            &organization_id,
            &domain_id,
            None,
            None,
            None,
            1,
        ))
        .await
        .unwrap(),
        "live binding needs a writer, not a frozen revision under a live label"
    );
    assert!(
        !db.create_grant_offer(&live(
            "offer:digest",
            &organization_id,
            &domain_id,
            Some("sha256:not-a-snapshot"),
            Some("writer:sponsor"),
            None,
            1,
        ))
        .await
        .unwrap(),
        "a live offer cannot also freeze a roster digest"
    );
}

#[tokio::test]
async fn a_live_offer_admits_under_its_trusted_writer_and_refuses_anyone_else() {
    let db = Db::connect_memory().await.unwrap();
    let (organization_id, domain_id) = seed_realm(&db, "org:one").await;
    seed_envelope(&db, &organization_id, &domain_id).await;
    assert!(db
        .create_grant_offer(&live(
            "offer:live",
            &organization_id,
            &domain_id,
            None,
            Some("writer:sponsor"),
            Some("contractor"),
            2,
        ))
        .await
        .unwrap());

    seed_person(&db, &organization_id, &domain_id, "grant:alice").await;
    seed_person(&db, &organization_id, &domain_id, "grant:mallory").await;
    seed_person(&db, &organization_id, &domain_id, "grant:bob").await;

    let mut outsider = live_activation("person:mallory", "grant:mallory", "claim:m");
    outsider.membership_issuer = "writer:nobody";
    assert_eq!(
        db.activate_grant_offer(&outsider).await.unwrap(),
        ActivationOutcome::Refused,
        "an unauthorized writer cannot expand a live cohort"
    );

    let mut wrong_class = live_activation("person:mallory", "grant:mallory", "claim:m2");
    wrong_class.membership_source = "admin";
    assert_eq!(
        db.activate_grant_offer(&wrong_class).await.unwrap(),
        ActivationOutcome::Refused,
        "a trusted writer still cannot mint a class the offer did not admit"
    );

    let mut late = live_activation("person:alice", "grant:alice", "claim:a");
    late.cohort_revision = 4;
    assert_eq!(
        db.activate_grant_offer(&late).await.unwrap(),
        ActivationOutcome::Bound,
        "live admission may advance past the create revision"
    );

    assert_eq!(
        db.activate_grant_offer(&live_activation("person:bob", "grant:bob", "claim:b"))
            .await
            .unwrap(),
        ActivationOutcome::Bound
    );

    seed_person(&db, &organization_id, &domain_id, "grant:carol").await;
    assert_eq!(
        db.activate_grant_offer(&live_activation("person:carol", "grant:carol", "claim:c"))
            .await
            .unwrap(),
        ActivationOutcome::Refused,
        "live cardinality is still a hard cap"
    );
}

fn snapshot<'a>(
    id: &'a str,
    organization_id: &'a str,
    domain_id: &'a str,
    cohort_revision: i64,
    roster_digest: Option<&'a str>,
    max_activations: i64,
) -> NewGrantOffer<'a> {
    NewGrantOffer {
        id,
        organization_id,
        domain_id,
        cohort_id: "cohort:raid",
        cohort_revision,
        membership_binding: "snapshot",
        roster_digest,
        trusted_writer: None,
        permitted_principal_class: None,
        envelope_grant_id: "grant:envelope",
        max_activations,
    }
}

fn live<'a>(
    id: &'a str,
    organization_id: &'a str,
    domain_id: &'a str,
    roster_digest: Option<&'a str>,
    trusted_writer: Option<&'a str>,
    permitted_principal_class: Option<&'a str>,
    max_activations: i64,
) -> NewGrantOffer<'a> {
    NewGrantOffer {
        id,
        organization_id,
        domain_id,
        cohort_id: "cohort:raid",
        cohort_revision: 1,
        membership_binding: "live",
        roster_digest,
        trusted_writer,
        permitted_principal_class,
        envelope_grant_id: "grant:envelope",
        max_activations,
    }
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

fn live_activation<'a>(
    principal: &'a str,
    grant_id: &'a str,
    idempotency_key: &'a str,
) -> OfferActivation<'a> {
    OfferActivation {
        offer_id: "offer:live",
        organization_id: "org:one",
        beneficiary_principal_id: principal,
        grant_id,
        cohort_revision: 1,
        membership_source: "contractor",
        membership_issuer: "writer:sponsor",
        idempotency_key,
    }
}

async fn seed_envelope(db: &Db, organization_id: &str, domain_id: &str) {
    seed_grant(db, organization_id, "grant:envelope").await;
    db.issue_authority(
        &issue("grant:envelope", organization_id, domain_id),
        &[entry("resource:A", "read")],
    )
    .await
    .unwrap();
}

async fn seed_person(db: &Db, organization_id: &str, domain_id: &str, grant_id: &str) {
    seed_grant(db, organization_id, grant_id).await;
    let mut child = issue(grant_id, organization_id, domain_id);
    child.parent_grant_id = Some("grant:envelope");
    child.issuance_basis = "delegation";
    child.delegation_depth_remaining = 0;
    // Envelope is [now-1m, now+1h] at seed time; stay strictly inside it.
    child.not_before = Utc::now();
    child.expires_at = Utc::now() + chrono::Duration::minutes(30);
    db.issue_authority(&child, &[entry("resource:A", "read")])
        .await
        .unwrap();
}
