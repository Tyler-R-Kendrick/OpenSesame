//! Backfilling legacy grants: resumable, idempotent, and never wider than what
//! was already enforced.
//!
//! The adversarial list for this one was explicit — a crash mid-migration, a
//! duplicate run, a malformed or expired or revoked record, and an old client that
//! would write the new rows back without the constraints it cannot parse.

mod authority_support;

use chrono::{Duration, Utc};
use opensesame_storage::authority::BackfillPlan;
use opensesame_storage::Db;

use authority_support::{legacy_body, seed_grant_body, seed_realm};

fn plan<'a>(organization_id: &'a str, domain_id: &'a str, batch: i64) -> BackfillPlan<'a> {
    BackfillPlan {
        name: "authority:0034",
        organization_id,
        domain_id,
        batch,
    }
}

#[tokio::test]
async fn a_backfill_will_not_start_without_a_verified_backup() {
    let db = Db::connect_memory().await.unwrap();
    let (organization_id, domain_id) = seed_realm(&db, "org:one").await;
    let refused = db
        .backfill_legacy_grants(&plan(&organization_id, &domain_id, 10))
        .await;
    assert!(refused.is_err(), "translate nothing without a backup");

    db.record_backfill_backup("authority:0034").await.unwrap();
    let report = db
        .backfill_legacy_grants(&plan(&organization_id, &domain_id, 10))
        .await
        .unwrap();
    assert_eq!((report.processed, report.quarantined), (0, 0));
    assert!(report.done);
}

#[tokio::test]
async fn a_translated_grant_keeps_its_window_and_gains_no_delegation() {
    let db = Db::connect_memory().await.unwrap();
    let (organization_id, domain_id) = seed_realm(&db, "org:one").await;
    db.record_backfill_backup("authority:0034").await.unwrap();
    let expires = Utc::now() + Duration::hours(6);
    seed_grant_body(
        &db,
        &organization_id,
        "grant:legacy",
        &legacy_body("grant:legacy", expires),
        None,
    )
    .await;

    let report = db
        .backfill_legacy_grants(&plan(&organization_id, &domain_id, 10))
        .await
        .unwrap();
    assert_eq!((report.processed, report.quarantined), (1, 0));

    let authority = db
        .fenced_authority(&organization_id, "grant:legacy", Utc::now())
        .await
        .unwrap()
        .expect("a translated grant is usable where it already was");
    assert_eq!(
        authority.delegation_depth_remaining, 0,
        "migration never hands out a delegation budget the record did not have"
    );
    // Two actions over one resource: the product the old engine really meant,
    // written out rather than inferred later.
    assert_eq!(authority.entries.len(), 2);
    for entry in &authority.entries {
        assert_eq!(entry.resource_selector, "connection:alpha");
        assert_eq!(
            entry.provider_operation_id,
            "connection.invoke:connection:alpha"
        );
        assert_eq!(entry.manifest_digest, "legacy:connection-broker");
    }
}

#[tokio::test]
async fn malformed_expired_and_revoked_records_are_quarantined_not_guessed() {
    let db = Db::connect_memory().await.unwrap();
    let (organization_id, domain_id) = seed_realm(&db, "org:one").await;
    db.record_backfill_backup("authority:0034").await.unwrap();

    seed_grant_body(
        &db,
        &organization_id,
        "grant:a-malformed",
        "{not json",
        None,
    )
    .await;
    seed_grant_body(
        &db,
        &organization_id,
        "grant:b-no-expiry",
        &serde_json::json!({
            "actions": ["read"],
            "resources": ["connection:alpha"],
            "connection_id": "connection:alpha",
            "constraints": {},
        })
        .to_string(),
        None,
    )
    .await;
    seed_grant_body(
        &db,
        &organization_id,
        "grant:c-expired",
        &legacy_body("grant:c-expired", Utc::now() - Duration::hours(1)),
        None,
    )
    .await;
    seed_grant_body(
        &db,
        &organization_id,
        "grant:d-revoked",
        &legacy_body("grant:d-revoked", Utc::now() + Duration::hours(6)),
        Some(Utc::now()),
    )
    .await;
    seed_grant_body(
        &db,
        &organization_id,
        "grant:e-no-provider",
        &serde_json::json!({
            "actions": ["read"],
            "resources": ["resource:mystery"],
            "constraints": {
                "expires_at": (Utc::now() + Duration::hours(6)).to_rfc3339(),
                "not_before": Utc::now().to_rfc3339(),
            },
        })
        .to_string(),
        None,
    )
    .await;

    let report = db
        .backfill_legacy_grants(&plan(&organization_id, &domain_id, 10))
        .await
        .unwrap();
    assert_eq!((report.processed, report.quarantined), (0, 5));
    for id in [
        "grant:a-malformed",
        "grant:b-no-expiry",
        "grant:c-expired",
        "grant:d-revoked",
        "grant:e-no-provider",
    ] {
        assert!(
            db.fenced_authority(&organization_id, id, Utc::now())
                .await
                .unwrap()
                .is_none(),
            "{id} must not have been translated"
        );
    }
}

#[tokio::test]
async fn a_crashed_pass_resumes_and_a_repeated_pass_writes_nothing() {
    let db = Db::connect_memory().await.unwrap();
    let (organization_id, domain_id) = seed_realm(&db, "org:one").await;
    db.record_backfill_backup("authority:0034").await.unwrap();
    let expires = Utc::now() + Duration::hours(6);
    for index in 0..5 {
        let id = format!("grant:legacy-{index}");
        seed_grant_body(&db, &organization_id, &id, &legacy_body(&id, expires), None).await;
    }

    // A pass that stopped after two rows — the batch is where the crash was.
    let first = db
        .backfill_legacy_grants(&plan(&organization_id, &domain_id, 2))
        .await
        .unwrap();
    assert_eq!(first.processed, 2);
    assert!(!first.done);
    let (_, _, cursor) = db
        .backfill_progress("authority:0034")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(cursor.as_deref(), Some("grant:legacy-1"));

    // Restarting resumes at the cursor rather than at the beginning.
    let second = db
        .backfill_legacy_grants(&plan(&organization_id, &domain_id, 10))
        .await
        .unwrap();
    assert_eq!(second.processed, 3);
    assert!(second.done);

    // And running again over the same range writes nothing: a grant with a sidecar
    // is already decided.
    let third = db
        .backfill_legacy_grants(&plan(&organization_id, &domain_id, 10))
        .await
        .unwrap();
    assert_eq!((third.processed, third.quarantined), (0, 0));
    for index in 0..5 {
        let entries = db
            .permission_entries(&organization_id, &format!("grant:legacy-{index}"))
            .await
            .unwrap();
        assert_eq!(entries.len(), 2, "no row was translated twice");
    }
}

#[tokio::test]
async fn a_grant_in_another_realm_is_out_of_scope_rather_than_quarantined() {
    let db = Db::connect_memory().await.unwrap();
    let (organization_id, domain_id) = seed_realm(&db, "org:one").await;
    let (other, _) = seed_realm(&db, "org:two").await;
    db.record_backfill_backup("authority:0034").await.unwrap();
    let expires = Utc::now() + Duration::hours(6);
    seed_grant_body(
        &db,
        &other,
        "grant:elsewhere",
        &legacy_body("grant:elsewhere", expires),
        None,
    )
    .await;

    let report = db
        .backfill_legacy_grants(&plan(&organization_id, &domain_id, 10))
        .await
        .unwrap();
    assert_eq!((report.processed, report.quarantined), (0, 0));
    assert!(db
        .fenced_authority(&other, "grant:elsewhere", Utc::now())
        .await
        .unwrap()
        .is_none());
}

#[tokio::test]
async fn a_client_below_the_floor_is_refused_by_name() {
    let db = Db::connect_memory().await.unwrap();
    db.assert_client_revision(1).await.unwrap();
    assert!(db.set_client_floor(3).await.unwrap());

    let refused = db.assert_client_revision(2).await;
    assert!(
        refused.is_err(),
        "an old client is refused, not accommodated"
    );
    assert!(refused
        .unwrap_err()
        .to_string()
        .contains("below the authority floor"));
    db.assert_client_revision(3).await.unwrap();

    assert!(
        !db.set_client_floor(1).await.unwrap(),
        "the floor does not fall"
    );
}
