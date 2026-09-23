//! LIFE-RENEWAL: AT-ROTATE-WINDOW and the SPIFFE half of AT-SPIFFE-OUTAGE.

use chrono::{Duration, Utc};

use crate::transport_lifecycle::renewal::{
    backoff_seconds, Claim, Scheduler, MAX_ATTEMPTS, MAX_QUEUE, RETRY_BASE_SECONDS,
    RETRY_CAP_SECONDS,
};
use crate::transport_lifecycle::test_support as support;

const ORG: &str = "org:1";

#[test]
fn backoff_is_bounded_at_both_ends_and_never_immediate() {
    for attempt in 1..=32u32 {
        for jitter in [0.0, 0.25, 0.5, 0.999, 1.0, -3.0, 7.0] {
            let delay = backoff_seconds(attempt, jitter);
            assert!(
                delay >= RETRY_BASE_SECONDS / 2,
                "attempt {attempt} jitter {jitter} gave {delay}",
            );
            assert!(
                delay <= RETRY_CAP_SECONDS,
                "attempt {attempt} jitter {jitter} gave {delay}",
            );
        }
    }
}

#[test]
fn jitter_actually_spreads_the_retry_rather_than_aligning_every_host() {
    let full = backoff_seconds(3, 0.0);
    let shaved = backoff_seconds(3, 1.0);
    assert!(shaved < full, "{shaved} !< {full}");
    assert!(shaved * 2 >= full, "jitter must not halve below step/2");
}

#[test]
fn one_certificate_is_claimed_once_so_two_ticks_cannot_double_issue() {
    let now = Utc::now();
    let mut scheduler = Scheduler::default();
    assert_eq!(scheduler.claim(ORG, "certificate:1", now), Claim::Claimed);
    assert_eq!(scheduler.claim(ORG, "certificate:1", now), Claim::InFlight);
    // A different certificate is unaffected.
    assert_eq!(scheduler.claim(ORG, "certificate:2", now), Claim::Claimed);
    scheduler.release_success(ORG, "certificate:1");
    assert_eq!(scheduler.claim(ORG, "certificate:1", now), Claim::Claimed);
}

#[test]
fn a_failure_backs_off_before_it_is_retried_and_parks_after_the_last_attempt() {
    let now = Utc::now();
    let mut scheduler = Scheduler::default();
    for attempt in 1..MAX_ATTEMPTS {
        scheduler.claim(ORG, "certificate:1", now);
        let retry = scheduler
            .release_failure(ORG, "certificate:1", "storage_error", now, 0.5)
            .expect("scheduled");
        assert_eq!(retry.attempts, attempt);
        assert!(!retry.parked);
        assert_eq!(
            scheduler.claim(ORG, "certificate:1", now),
            Claim::BackingOff
        );
    }
    scheduler.claim(ORG, "certificate:1", now + Duration::days(1));
    let parked = scheduler
        .release_failure(ORG, "certificate:1", "storage_error", now, 0.5)
        .expect("scheduled");
    assert!(parked.parked, "the last attempt must park for a human");
    assert_eq!(
        scheduler.claim(ORG, "certificate:1", now + Duration::days(7)),
        Claim::Parked,
        "a parked certificate never retries on its own, however long it waits",
    );
    assert_eq!(scheduler.entries().filter(|retry| retry.parked).count(), 1);
}

#[test]
fn the_retry_queue_is_bounded_so_a_flood_cannot_grow_the_task_count() {
    let now = Utc::now();
    let mut scheduler = Scheduler::default();
    for index in 0..MAX_QUEUE + 20 {
        let id = format!("certificate:{index}");
        scheduler.claim(ORG, &id, now);
        scheduler.release_failure(ORG, &id, "storage_error", now, 0.5);
    }
    assert_eq!(scheduler.entries().count(), MAX_QUEUE);
    assert_eq!(scheduler.overflowed, 20);
    // The ones already tracked keep retrying; the refusal is visible, not silent.
    assert!(scheduler.due(now + Duration::hours(1)).len() <= MAX_QUEUE);
}

#[test]
fn only_due_unparked_entries_are_retried() {
    let now = Utc::now();
    let mut scheduler = Scheduler::default();
    scheduler.claim(ORG, "certificate:1", now);
    scheduler.release_failure(ORG, "certificate:1", "storage_error", now, 0.0);
    assert!(scheduler.due(now).is_empty(), "not due yet");
    assert_eq!(scheduler.due(now + Duration::hours(1)).len(), 1);
    scheduler.forget(ORG, "certificate:1");
    assert!(scheduler.due(now + Duration::hours(1)).is_empty());
}

#[tokio::test]
async fn a_workload_api_identity_is_skipped_rather_than_reissued_by_this_host() {
    // AT-SPIFFE-OUTAGE's lifecycle half: a SPIFFE source owns its snapshots,
    // so a source outage must never make this host mint a competing leaf.
    let state = support::state_with_authority().await;
    let organization = state.connection_organization;
    let issued = crate::transport_lifecycle::issuance::issue_for_transport(
        &state,
        &organization,
        support::listener_request("host.test"),
        "operator",
    )
    .await
    .expect("issue");

    // Rewrite the row's source to the workload API, as the SPIFFE adapter does.
    let row = state
        .db
        .get_certificate(&organization.to_string(), &issued.certificate_id)
        .await
        .expect("read")
        .expect("row");
    let mut metadata: serde_json::Value =
        serde_json::from_str(&row.metadata_json).expect("metadata");
    metadata["transport"]["source"] = serde_json::json!("spiffe_workload_api");
    // Written through the pool rather than `set_certificate_metadata`, whose
    // public contract is scalar top-level fields only; the transport document
    // this row actually carries is written at insert by
    // `managed_certs::issue_managed_material`, which is what is being
    // simulated here.
    sqlx::query(
        "UPDATE issued_certificates SET metadata_json = ? WHERE organization_id = ? AND id = ?",
    )
    .bind(metadata.to_string())
    .bind(organization.to_string())
    .bind(&issued.certificate_id)
    .execute(state.db.pool())
    .await
    .expect("update metadata");

    let outcome = crate::transport_lifecycle::renewal::renew_one(
        &state,
        &organization,
        &issued.certificate_id,
    )
    .await;
    assert!(outcome.succeeded, "{}", outcome.detail);
    assert!(
        outcome.detail.contains("workload api"),
        "the skip must say why: {}",
        outcome.detail,
    );
}

#[tokio::test]
async fn a_certificate_that_does_not_exist_fails_loudly_rather_than_looping() {
    let state = support::state().await;
    let organization = state.connection_organization;
    let outcome =
        crate::transport_lifecycle::renewal::renew_one(&state, &organization, "certificate:nope")
            .await;
    assert!(!outcome.succeeded);
    assert!(
        outcome.detail.starts_with("not_found"),
        "{}",
        outcome.detail
    );
}
