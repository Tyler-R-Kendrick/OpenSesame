//! Concurrency and degradation ("chaos") coverage for the Certificate Manager
//! storage layer.
//!
//! Every case races real tasks against real single-use state and asserts the
//! fail-closed property: exactly one winner for a single-use token, never more
//! signatures than the cap allows, no partial rows after a rolled-back
//! transaction, and bounded rejection — never a panic — for oversized input.
//! These are security properties, not ergonomics.

mod support;

use std::sync::Arc;
use std::time::Duration;

use futures::future::join_all;
use opensesame_storage::Db;
use support::{
    access_record, approval_policy, approval_request, seed_certificate, seed_org, signer, ORG_ONE,
};

/// Hard per-case deadline so a regression that deadlocks fails fast.
const DEADLINE: Duration = Duration::from_secs(30);

/// A file-backed database, because racing tasks need more than the single
/// connection an in-memory `SQLite` pool allows.
async fn racing_db(directory: &std::path::Path) -> Arc<Db> {
    let url = format!("sqlite://{}/chaos.db?mode=rwc", directory.display());
    Arc::new(Db::connect_sqlite(&url).await.expect("migrate"))
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn chaos_exactly_one_task_consumes_a_scep_challenge() {
    let directory = tempdir();
    let db = racing_db(directory.path()).await;
    let (_, _, profile_id, _) = seed_org(&db, ORG_ONE, "one").await;
    db.insert_scep_config(&scep_config(&profile_id))
        .await
        .expect("scep config");
    db.mint_scep_challenge(
        ORG_ONE,
        "scep:one",
        "sha256:challenge",
        "2099-01-01T00:00:00+00:00",
    )
    .await
    .expect("mint");

    let attempts = (0..16).map(|_| {
        let db = Arc::clone(&db);
        tokio::spawn(async move {
            db.consume_scep_challenge(ORG_ONE, "scep:one", "sha256:challenge")
                .await
                .is_ok()
        })
    });
    let winners = tokio::time::timeout(DEADLINE, join_all(attempts))
        .await
        .expect("no deadlock")
        .into_iter()
        .filter(|outcome| *outcome.as_ref().expect("task"))
        .count();
    assert_eq!(
        winners, 1,
        "a single-use challenge admitted {winners} callers"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn chaos_exactly_one_task_consumes_an_acme_nonce() {
    let directory = tempdir();
    let db = racing_db(directory.path()).await;
    let nonce = db.mint_acme_nonce(ORG_ONE).await.expect("mint");

    let attempts = (0..16).map(|_| {
        let db = Arc::clone(&db);
        let nonce = nonce.clone();
        tokio::spawn(async move { db.consume_acme_nonce(ORG_ONE, &nonce).await.is_ok() })
    });
    let winners = tokio::time::timeout(DEADLINE, join_all(attempts))
        .await
        .expect("no deadlock")
        .into_iter()
        .filter(|outcome| *outcome.as_ref().expect("task"))
        .count();
    assert_eq!(winners, 1, "a single-use nonce admitted {winners} callers");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn chaos_signature_cap_holds_under_a_racing_swarm() {
    let directory = tempdir();
    let db = racing_db(directory.path()).await;
    seed_org(&db, ORG_ONE, "one").await;
    db.insert_signer(&signer(ORG_ONE, "signer:one"))
        .await
        .expect("signer");
    db.insert_signing_access_record(&access_record(ORG_ONE, "record:one", "signer:one", Some(5)))
        .await
        .expect("record");

    let attempts = (0..32).map(|_| {
        let db = Arc::clone(&db);
        tokio::spawn(async move {
            db.increment_signature_count(ORG_ONE, "record:one")
                .await
                .ok()
        })
    });
    let granted: Vec<u32> = tokio::time::timeout(DEADLINE, join_all(attempts))
        .await
        .expect("no deadlock")
        .into_iter()
        .filter_map(|outcome| outcome.expect("task"))
        .collect();
    assert_eq!(
        granted.len(),
        5,
        "the cap admitted {} signatures",
        granted.len()
    );

    let mut sorted = granted;
    sorted.sort_unstable();
    // Every grant handed back a distinct sequence number: no two signers were
    // ever told they held the same slot.
    assert_eq!(sorted, vec![1, 2, 3, 4, 5]);
    assert_eq!(
        db.get_signing_access_record(ORG_ONE, "record:one")
            .await
            .expect("record")
            .expect("present")
            .signatures_used,
        5
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn chaos_only_one_approver_wins_a_racing_transition() {
    let directory = tempdir();
    let db = racing_db(directory.path()).await;
    let (_, _, _, application_id) = seed_org(&db, ORG_ONE, "one").await;
    db.insert_approval_policy(&approval_policy(ORG_ONE, "approval:one", &application_id))
        .await
        .expect("policy");
    db.insert_approval_request(&approval_request(ORG_ONE, "request:one", "approval:one"))
        .await
        .expect("request");

    let approve = {
        let db = Arc::clone(&db);
        tokio::spawn(async move {
            db.transition_approval_request(ORG_ONE, "request:one", "open", "approved")
                .await
                .is_ok()
        })
    };
    let reject = {
        let db = Arc::clone(&db);
        tokio::spawn(async move {
            db.transition_approval_request(ORG_ONE, "request:one", "open", "rejected")
                .await
                .is_ok()
        })
    };
    let outcomes = tokio::time::timeout(DEADLINE, join_all([approve, reject]))
        .await
        .expect("no deadlock");
    let winners = outcomes
        .into_iter()
        .filter(|outcome| *outcome.as_ref().expect("task"))
        .count();
    assert_eq!(winners, 1, "both approvers transitioned the same request");
    let status = db
        .get_approval_request(ORG_ONE, "request:one")
        .await
        .expect("request")
        .expect("present")
        .status;
    assert!(status == "approved" || status == "rejected");
}

#[tokio::test]
async fn chaos_a_failed_renewal_link_leaves_no_partial_write() {
    let db = Db::connect_memory().await.expect("migrate");
    let (authority, ..) = seed_org(&db, ORG_ONE, "one").await;
    let first = seed_certificate(&db, ORG_ONE, &authority, "alpha").await;

    // The successor does not exist, so the second statement matches no row and
    // the whole transaction must roll back.
    assert!(db
        .insert_renewal_link(ORG_ONE, &first.id, "cert:missing")
        .await
        .is_err());
    let reread = db
        .get_certificate(ORG_ONE, &first.id)
        .await
        .expect("certificate")
        .expect("present");
    assert_eq!(reread.renewed_by_id, None);
    assert_eq!(reread.version, first.version);

    // Likewise for a revocation whose certificate belongs to another tenant.
    assert!(db
        .insert_certificate_revocation(&opensesame_storage::StoredCertificateRevocation {
            id: "revocation:orphan".into(),
            organization_id: ORG_ONE.into(),
            certificate_id: "cert:missing".into(),
            ca_id: authority.clone(),
            serial: "serial:missing".into(),
            reason_code: 1,
            revoked_at: support::NOW.into(),
            crl_number: Some(1),
            version: 1,
            created_at: support::NOW.into(),
            updated_at: support::NOW.into(),
        })
        .await
        .is_err());
    assert!(db
        .list_revocations_for_ca(ORG_ONE, &authority)
        .await
        .expect("revocations")
        .is_empty());
}

#[tokio::test]
async fn chaos_oversized_inputs_are_rejected_rather_than_stored() {
    let db = Db::connect_memory().await.expect("migrate");
    let (authority, ..) = seed_org(&db, ORG_ONE, "one").await;
    let certificate = seed_certificate(&db, ORG_ONE, &authority, "alpha").await;

    // A 10 MB metadata value is refused by the bound, not by the database and
    // not by an allocation failure.
    let huge = format!(r#"{{"blob":"{}"}}"#, "a".repeat(10 * 1024 * 1024));
    assert!(db
        .set_certificate_metadata(ORG_ONE, &certificate.id, &huge)
        .await
        .is_err());
    assert_eq!(
        db.get_certificate_metadata(ORG_ONE, &certificate.id)
            .await
            .expect("metadata")
            .as_deref(),
        Some("{}")
    );

    // A 100k-character common name is stored verbatim but never widens the
    // filter: the LIKE pattern stays a single bound parameter.
    let long_cn = "x".repeat(100_000);
    let filter = opensesame_storage::CertificateFilter {
        common_name_contains: Some(long_cn.clone()),
        ..opensesame_storage::CertificateFilter::default()
    };
    let query = filter.to_query();
    assert!(!query.sql.contains(&long_cn));
    assert_eq!(query.text_binds.len(), 1);
    assert!(db
        .list_certificates(ORG_ONE, &filter)
        .await
        .expect("list")
        .is_empty());

    // A key count far past the bound is refused without panicking.
    let many_keys: String = format!(
        "{{{}}}",
        (0..500)
            .map(|index| format!(r#""k{index}":"v""#))
            .collect::<Vec<_>>()
            .join(",")
    );
    assert!(db
        .set_certificate_metadata(ORG_ONE, &certificate.id, &many_keys)
        .await
        .is_err());
}

fn scep_config(profile_id: &str) -> opensesame_storage::StoredScepConfig {
    opensesame_storage::StoredScepConfig {
        id: "scep:one".into(),
        organization_id: ORG_ONE.into(),
        profile_id: profile_id.into(),
        challenge_mode: "dynamic".into(),
        sealed_static_secret: None,
        ra_signs_with_ca: true,
        include_ca_cert: true,
        allow_cert_renewal: false,
        version: 1,
        created_at: support::NOW.into(),
        updated_at: support::NOW.into(),
    }
}

/// Minimal scratch directory helper: the crate has no `tempfile` dependency and
/// the chaos suite only needs one throwaway path per case.
fn tempdir() -> ScratchDir {
    let path = std::env::temp_dir().join(format!(
        "opensesame-storage-chaos-{}",
        uuid::Uuid::new_v4().simple()
    ));
    std::fs::create_dir_all(&path).expect("scratch directory");
    ScratchDir { path }
}

struct ScratchDir {
    path: std::path::PathBuf,
}

impl ScratchDir {
    fn path(&self) -> &std::path::Path {
        &self.path
    }
}

impl Drop for ScratchDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.path);
    }
}
