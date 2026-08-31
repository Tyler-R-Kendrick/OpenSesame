//! Host-custody certificate storage (ADR 0075).
//!
//! The promise these protect is a single invariant: a managed certificate and
//! its sealed private key exist together or not at all. A certificate row
//! without its key is unrenewable *and* undeployable, so a half-written pair is
//! worse than no pair.

mod support;

use opensesame_storage::{
    Db, SealedCertificateMaterial, StoredManagedCertificate, StoredManagedCertificateKey,
};
use support::{certificate, issuance_request, seed_org, NOW, ORG_ONE, ORG_TWO};

fn managed_key(organization_id: &str, certificate_id: &str) -> StoredManagedCertificateKey {
    StoredManagedCertificateKey {
        id: format!("managed-key:{certificate_id}"),
        organization_id: organization_id.into(),
        certificate_id: certificate_id.into(),
        sealed_key: SealedCertificateMaterial {
            key_id: "opensesame-connection-key:v1".into(),
            ciphertext: vec![9, 9, 9],
            nonce: vec![4, 4, 4],
            aad_digest: format!("sha256:{certificate_id}"),
        },
        version: 1,
        created_at: NOW.into(),
        updated_at: NOW.into(),
    }
}

fn managed_certificate(
    organization_id: &str,
    authority_id: &str,
    request_id: &str,
    id: &str,
) -> StoredManagedCertificate {
    StoredManagedCertificate {
        auto_renew_enabled: true,
        renew_before_seconds: Some(7 * 86_400),
        ..certificate(organization_id, authority_id, request_id, id)
    }
}

/// A request the completion guard will accept, returned with its id.
async fn pending_request(db: &Db, organization_id: &str, authority_id: &str, id: &str) -> String {
    db.insert_certificate_issuance_request(&issuance_request(organization_id, authority_id, id))
        .await
        .expect("issuance request");
    id.to_string()
}

#[tokio::test]
async fn given_a_pending_request_when_managed_issuance_completes_then_certificate_and_key_land_together(
) {
    // given
    let db = Db::connect_memory().await.unwrap();
    let (authority_id, ..) = seed_org(&db, ORG_ONE, "one").await;
    let request_id = pending_request(&db, ORG_ONE, &authority_id, "request:managed").await;
    let record = managed_certificate(ORG_ONE, &authority_id, &request_id, "cert:managed");
    let key = managed_key(ORG_ONE, &record.id);

    // when
    let completed = db
        .complete_managed_certificate_issuance(ORG_ONE, &request_id, 1, "created", &record, &key)
        .await
        .expect("managed completion");

    // then
    assert!(completed);
    let stored = db
        .get_certificate(ORG_ONE, &record.id)
        .await
        .unwrap()
        .expect("certificate");
    assert!(
        stored.auto_renew_enabled,
        "custody implies unattended renewal"
    );
    assert_eq!(stored.renew_before_seconds, Some(7 * 86_400));
    let held = db
        .get_managed_certificate_key(ORG_ONE, &record.id)
        .await
        .unwrap()
        .expect("the host holds the key");
    assert_eq!(held.sealed_key.ciphertext, vec![9, 9, 9]);
}

#[tokio::test]
async fn given_a_stale_request_version_when_completion_runs_then_nothing_is_written() {
    // given
    let db = Db::connect_memory().await.unwrap();
    let (authority_id, ..) = seed_org(&db, ORG_ONE, "one").await;
    let request_id = pending_request(&db, ORG_ONE, &authority_id, "request:stale").await;
    let record = managed_certificate(ORG_ONE, &authority_id, &request_id, "cert:stale");
    let key = managed_key(ORG_ONE, &record.id);

    // when — version 2 does not match the stored version 1
    let completed = db
        .complete_managed_certificate_issuance(ORG_ONE, &request_id, 2, "created", &record, &key)
        .await
        .expect("managed completion");

    // then — no certificate, and no orphan key either
    assert!(!completed);
    assert!(db
        .get_certificate(ORG_ONE, &record.id)
        .await
        .unwrap()
        .is_none());
    assert!(db
        .get_managed_certificate_key(ORG_ONE, &record.id)
        .await
        .unwrap()
        .is_none());
}

#[tokio::test]
async fn given_an_incomplete_sealed_key_when_completion_runs_then_no_certificate_is_written() {
    // given — a key whose sealed group is missing its ciphertext
    let db = Db::connect_memory().await.unwrap();
    let (authority_id, ..) = seed_org(&db, ORG_ONE, "one").await;
    let request_id = pending_request(&db, ORG_ONE, &authority_id, "request:broken").await;
    let record = managed_certificate(ORG_ONE, &authority_id, &request_id, "cert:broken");
    let mut key = managed_key(ORG_ONE, &record.id);
    key.sealed_key.ciphertext = Vec::new();

    // when
    let outcome = db
        .complete_managed_certificate_issuance(ORG_ONE, &request_id, 1, "created", &record, &key)
        .await;

    // then — refused before the transaction, so the request is still pending
    assert!(outcome.is_err());
    assert!(db
        .get_certificate(ORG_ONE, &record.id)
        .await
        .unwrap()
        .is_none());
    let request = db
        .find_certificate_issuance_by_idempotency(ORG_ONE, &format!("idem:{request_id}"))
        .await
        .unwrap()
        .expect("request survives");
    assert_eq!(request.state, "created");
}

#[tokio::test]
async fn given_a_key_for_another_certificate_when_completion_runs_then_it_is_refused() {
    // given
    let db = Db::connect_memory().await.unwrap();
    let (authority_id, ..) = seed_org(&db, ORG_ONE, "one").await;
    let request_id = pending_request(&db, ORG_ONE, &authority_id, "request:mismatch").await;
    let record = managed_certificate(ORG_ONE, &authority_id, &request_id, "cert:mismatch");
    let key = managed_key(ORG_ONE, "cert:somebody-else");

    // when
    let outcome = db
        .complete_managed_certificate_issuance(ORG_ONE, &request_id, 1, "created", &record, &key)
        .await;

    // then — a key must never be filed against a certificate it does not open
    assert!(outcome.is_err());
    assert!(db
        .get_certificate(ORG_ONE, &record.id)
        .await
        .unwrap()
        .is_none());
}

#[tokio::test]
async fn given_a_certificate_in_another_organization_when_completion_runs_then_it_is_refused() {
    let db = Db::connect_memory().await.unwrap();
    let (authority_id, ..) = seed_org(&db, ORG_ONE, "one").await;
    seed_org(&db, ORG_TWO, "two").await;
    let request_id = pending_request(&db, ORG_ONE, &authority_id, "request:tenant").await;
    let record = managed_certificate(ORG_TWO, &authority_id, &request_id, "cert:tenant");
    let key = managed_key(ORG_TWO, &record.id);

    let outcome = db
        .complete_managed_certificate_issuance(ORG_ONE, &request_id, 1, "created", &record, &key)
        .await;

    assert!(outcome.is_err());
}

#[tokio::test]
async fn given_an_expired_request_when_completion_runs_then_no_certificate_is_minted() {
    // given — a request whose window has closed
    let db = Db::connect_memory().await.unwrap();
    let (authority_id, ..) = seed_org(&db, ORG_ONE, "one").await;
    let mut request = issuance_request(ORG_ONE, &authority_id, "request:expired");
    request.expires_at = "2000-01-01T00:00:00+00:00".into();
    db.insert_certificate_issuance_request(&request)
        .await
        .unwrap();
    let record = managed_certificate(ORG_ONE, &authority_id, &request.id, "cert:expired");
    let key = managed_key(ORG_ONE, &record.id);

    // when
    let completed = db
        .complete_managed_certificate_issuance(ORG_ONE, &request.id, 1, "created", &record, &key)
        .await
        .expect("managed completion");

    // then
    assert!(!completed, "an expired request must not mint a certificate");
    assert!(db
        .get_certificate(ORG_ONE, &record.id)
        .await
        .unwrap()
        .is_none());
}

#[tokio::test]
async fn given_a_renewed_certificate_when_it_is_retired_then_it_leaves_the_expiry_sweep() {
    // given
    let db = Db::connect_memory().await.unwrap();
    let (authority_id, ..) = seed_org(&db, ORG_ONE, "one").await;
    let request_id = pending_request(&db, ORG_ONE, &authority_id, "request:retire").await;
    let record = managed_certificate(ORG_ONE, &authority_id, &request_id, "cert:retire");
    db.complete_managed_certificate_issuance(
        ORG_ONE,
        &request_id,
        1,
        "created",
        &record,
        &managed_key(ORG_ONE, &record.id),
    )
    .await
    .unwrap();
    let horizon = "2099-01-01T00:00:00+00:00";
    assert_eq!(
        db.list_certificates_expiring_before(ORG_ONE, horizon)
            .await
            .unwrap()
            .len(),
        1,
    );

    // when
    assert!(db
        .mark_certificate_renewed(ORG_ONE, &record.id)
        .await
        .unwrap());

    // then — the scanner stops warning about a deadline that no longer matters
    assert!(db
        .list_certificates_expiring_before(ORG_ONE, horizon)
        .await
        .unwrap()
        .is_empty());
    let stored = db
        .get_certificate(ORG_ONE, &record.id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(stored.status, "renewed");

    // …and retiring it twice is a no-op rather than a second version bump.
    assert!(!db
        .mark_certificate_renewed(ORG_ONE, &record.id)
        .await
        .unwrap());
}

#[tokio::test]
async fn given_a_revoked_certificate_when_retirement_runs_then_revocation_is_not_overwritten() {
    // given — revocation and supersession are different facts and a reviewer
    // needs them to stay different.
    let db = Db::connect_memory().await.unwrap();
    let (authority_id, ..) = seed_org(&db, ORG_ONE, "one").await;
    let request_id = pending_request(&db, ORG_ONE, &authority_id, "request:revoked").await;
    let record = managed_certificate(ORG_ONE, &authority_id, &request_id, "cert:revoked");
    db.complete_managed_certificate_issuance(
        ORG_ONE,
        &request_id,
        1,
        "created",
        &record,
        &managed_key(ORG_ONE, &record.id),
    )
    .await
    .unwrap();
    db.insert_certificate_revocation(&opensesame_storage::StoredCertificateRevocation {
        id: "revocation:one".into(),
        organization_id: ORG_ONE.into(),
        certificate_id: record.id.clone(),
        ca_id: authority_id.clone(),
        serial: record.serial_number.clone(),
        reason_code: 1,
        revoked_at: NOW.into(),
        crl_number: None,
        version: 1,
        created_at: NOW.into(),
        updated_at: NOW.into(),
    })
    .await
    .unwrap();

    // when
    let retired = db
        .mark_certificate_renewed(ORG_ONE, &record.id)
        .await
        .unwrap();

    // then
    assert!(!retired, "a revoked certificate is not merely superseded");
    let stored = db
        .get_certificate(ORG_ONE, &record.id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(stored.status, "revoked");
}
