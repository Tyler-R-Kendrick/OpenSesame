//! The Host's event rows rest sealed (ADR 0156). Every assertion reads the
//! table itself, not the API: what a copied database file would show.

use opensesame_storage::{Db, StoredSecurityDelivery};
use sqlx::Row as _;

/// The sealer is process-wide; tests that install it take turns.
static SERIAL: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
const KEY: [u8; 32] = [7; 32];
const SENTINEL: &str = "SENTINEL-hunter2";

/// A fresh in-memory database with foreign keys off: these tests are about the
/// value at rest, not about the hook or run a row would normally hang from.
async fn db_without_parents() -> Db {
    let db = Db::connect_memory().await.unwrap();
    sqlx::query("PRAGMA foreign_keys = OFF")
        .execute(db.pool())
        .await
        .unwrap();
    db
}

async fn raw(db: &Db, sql: &str) -> String {
    sqlx::query(sql)
        .fetch_one(db.pool())
        .await
        .unwrap()
        .get::<String, _>(0)
}

fn delivery(id: &str, payload: &str) -> StoredSecurityDelivery {
    StoredSecurityDelivery {
        id: id.into(),
        organization_id: "org-1".into(),
        hook_id: "hook-1".into(),
        event_type: "lifecycle.expiry.urgent".into(),
        subject_kind: "certificate".into(),
        subject_id: "cert-1".into(),
        payload_json: payload.into(),
        state: "pending".into(),
        attempts: 0,
        available_at: None,
        last_error: None,
        delivered_at: None,
        created_at: "2026-09-28T00:00:00Z".into(),
        updated_at: "2026-09-28T00:00:00Z".into(),
    }
}

#[tokio::test]
async fn the_outbox_rests_sealed_and_reads_back_whole() {
    let _turn = SERIAL.lock().await;
    opensesame_event_seal::install(&KEY);
    let db = Db::connect_memory().await.unwrap();
    let payload = format!(r#"{{"note":"{SENTINEL}"}}"#);
    let id = db.append_outbox("test.event", &payload).await.unwrap();

    let stored = raw(&db, "SELECT payload_json FROM outbox_events").await;
    assert!(stored.starts_with("osev1.") && !stored.contains(SENTINEL));

    let claimed = db.claim_outbox_batch(10, 30).await.unwrap();
    assert_eq!(claimed.len(), 1);
    assert_eq!(claimed[0].payload_json, payload);

    db.park_outbox(&[id], "POST https://hook.example/x?token=abc123 refused", 5)
        .await
        .unwrap();
    let error = raw(&db, "SELECT last_error FROM outbox_events").await;
    assert!(
        !error.contains("abc123") && error.contains("refused"),
        "{error}"
    );
    opensesame_event_seal::clear();
}

#[tokio::test]
async fn a_security_delivery_rests_sealed_and_its_failure_is_scrubbed() {
    let _turn = SERIAL.lock().await;
    opensesame_event_seal::install(&KEY);
    let db = db_without_parents().await;
    let payload = format!(r#"{{"summary":"{SENTINEL}"}}"#);
    db.enqueue_security_delivery(&delivery("d-1", &payload))
        .await
        .unwrap();

    let stored = raw(&db, "SELECT payload_json FROM security_deliveries").await;
    assert!(stored.starts_with("osev1.") && !stored.contains(SENTINEL));
    let listed = db.list_security_deliveries("org-1", 10).await.unwrap();
    assert_eq!(listed[0].payload_json, payload);

    db.dead_letter_security_delivery(
        "d-1",
        "request failed: https://h.example/x#token=abc123",
        chrono::Utc::now(),
    )
    .await
    .unwrap();
    let error = raw(&db, "SELECT last_error FROM security_deliveries").await;
    assert!(!error.contains("abc123"), "{error}");
    opensesame_event_seal::clear();
}

#[tokio::test]
async fn a_runner_step_rests_sealed_and_settles() {
    let _turn = SERIAL.lock().await;
    opensesame_event_seal::install(&KEY);
    let db = db_without_parents().await;
    sqlx::query(
        "INSERT INTO observation_runs (id, organization_id, job_id, target_origin, tier, control_state, \
         owner_principal_id, viewer_key_id, expires_at, created_at, updated_at) \
         VALUES ('run-1', 'org-1', 'job-1', 'https://rp.example', 't3', 'agent_driving', \
                 'owner-1', 'key-1', '2099-01-01T00:00:00Z', '2026-09-28T00:00:00Z', '2026-09-28T00:00:00Z')",
    )
    .execute(db.pool())
    .await
    .unwrap();
    let request = format!(r#"{{"credential_ref":"{SENTINEL}"}}"#);
    db.enqueue_runner_step("org-1", "run-1", 1, &request, "2026-09-28T00:00:00Z")
        .await
        .unwrap();
    let stored = raw(&db, "SELECT request_json FROM runner_steps").await;
    assert!(stored.starts_with("osev1.") && !stored.contains(SENTINEL));

    let claimed = db
        .claim_runner_step(
            "org-1",
            "run-1",
            "driver",
            "2026-09-28T00:00:01Z",
            "2026-09-28T00:05:00Z",
        )
        .await
        .unwrap()
        .expect("a pending step is claimable");
    assert_eq!(claimed.request_json, request);

    let outcome = format!(r#"{{"result":"{SENTINEL}"}}"#);
    assert!(db
        .settle_runner_step(
            "org-1",
            "run-1",
            1,
            "driver",
            &outcome,
            "2026-09-28T00:00:02Z"
        )
        .await
        .unwrap());
    let stored = raw(&db, "SELECT outcome_json FROM runner_steps").await;
    assert!(stored.starts_with("osev1.") && !stored.contains(SENTINEL));
    let step = db
        .get_runner_step("org-1", "run-1", 1)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(step.outcome_json.as_deref(), Some(outcome.as_str()));

    // The executor's rewrite of the settled outcome is the third writer of the
    // column: it must seal too.
    let accepted = format!(r#"{{"accepted":"{SENTINEL}"}}"#);
    assert!(db
        .replace_settled_runner_step_outcome("org-1", "run-1", 1, &accepted)
        .await
        .unwrap());
    let stored = raw(&db, "SELECT outcome_json FROM runner_steps").await;
    assert!(stored.starts_with("osev1.") && !stored.contains(SENTINEL));
    let step = db
        .get_runner_step("org-1", "run-1", 1)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(step.outcome_json.as_deref(), Some(accepted.as_str()));
    opensesame_event_seal::clear();
}

#[tokio::test]
async fn rows_an_older_build_left_in_the_clear_are_sealed_once() {
    let _turn = SERIAL.lock().await;
    opensesame_event_seal::clear();
    let db = db_without_parents().await;
    let payload = format!(r#"{{"note":"{SENTINEL}"}}"#);
    db.append_outbox("legacy.event", &payload).await.unwrap();
    db.enqueue_security_delivery(&delivery("d-legacy", &payload))
        .await
        .unwrap();
    assert!(raw(&db, "SELECT payload_json FROM outbox_events")
        .await
        .contains(SENTINEL));

    assert_eq!(
        db.seal_legacy_events().await.unwrap(),
        0,
        "no sealer, no sweep"
    );
    opensesame_event_seal::install(&KEY);
    assert_eq!(db.seal_legacy_events().await.unwrap(), 2);
    assert_eq!(
        db.seal_legacy_events().await.unwrap(),
        0,
        "a second pass finds nothing"
    );

    for sql in [
        "SELECT payload_json FROM outbox_events",
        "SELECT payload_json FROM security_deliveries",
    ] {
        let stored = raw(&db, sql).await;
        assert!(
            stored.starts_with("osev1.") && !stored.contains(SENTINEL),
            "{sql}"
        );
    }
    let claimed = db.claim_outbox_batch(10, 30).await.unwrap();
    assert_eq!(claimed[0].payload_json, payload);
    opensesame_event_seal::clear();
}

#[tokio::test]
async fn a_sealed_row_with_no_sealer_is_an_error_not_ciphertext() {
    let _turn = SERIAL.lock().await;
    opensesame_event_seal::install(&KEY);
    let db = Db::connect_memory().await.unwrap();
    db.append_outbox("test.event", r#"{"a":1}"#).await.unwrap();
    opensesame_event_seal::clear();
    assert!(
        db.claim_outbox_batch(10, 30).await.is_err(),
        "with no sealer a missing key must not dead-letter the queue"
    );
    opensesame_event_seal::install(&KEY);
    assert_eq!(db.claim_outbox_batch(10, 30).await.unwrap().len(), 1);
    opensesame_event_seal::clear();
}

#[tokio::test]
async fn an_unreadable_outbox_row_is_quarantined_and_the_queue_moves_on() {
    let _turn = SERIAL.lock().await;
    opensesame_event_seal::install(&[9; 32]);
    let db = Db::connect_memory().await.unwrap();
    let old = db.append_outbox("old.key", r#"{"a":1}"#).await.unwrap();
    opensesame_event_seal::install(&KEY);
    let newer = db.append_outbox("new.key", r#"{"b":2}"#).await.unwrap();

    let claimed = db.claim_outbox_batch(10, 30).await.unwrap();
    assert_eq!(claimed.len(), 1, "the readable row is not held behind it");
    assert_eq!(claimed[0].id, newer);
    let reason = raw(
        &db,
        &format!("SELECT last_error FROM outbox_events WHERE id = '{old}'"),
    )
    .await;
    assert_eq!(reason, "unreadable: sealed value did not open");
    let kept = raw(
        &db,
        &format!("SELECT payload_json FROM outbox_events WHERE id = '{old}'"),
    )
    .await;
    assert!(
        kept.starts_with("osev1."),
        "the sealed value is left as it was"
    );
    assert!(
        db.claim_outbox_batch(10, 0)
            .await
            .unwrap()
            .iter()
            .all(|e| e.id != old),
        "and the quarantined row is not claimed again"
    );
    opensesame_event_seal::clear();
}

#[tokio::test]
async fn an_unreadable_security_delivery_is_dead_lettered_and_the_queue_moves_on() {
    let _turn = SERIAL.lock().await;
    opensesame_event_seal::install(&[9; 32]);
    let db = db_without_parents().await;
    db.enqueue_security_delivery(&delivery("d-old", r#"{"a":1}"#))
        .await
        .unwrap();
    opensesame_event_seal::install(&KEY);
    let mut newer = delivery("d-new", r#"{"b":2}"#);
    newer.created_at = "2026-09-29T00:00:00Z".into();
    db.enqueue_security_delivery(&newer).await.unwrap();

    let claimed = db
        .claim_security_deliveries(10, 30, chrono::Utc::now())
        .await
        .unwrap();
    assert_eq!(claimed.len(), 1);
    assert_eq!(claimed[0].id, "d-new");
    let state = raw(
        &db,
        "SELECT state || '|' || last_error FROM security_deliveries WHERE id = 'd-old'",
    )
    .await;
    assert_eq!(state, "dead_lettered|unreadable: sealed value did not open");
    opensesame_event_seal::clear();
}

#[tokio::test]
async fn legacy_plaintext_in_any_case_of_the_prefix_is_sealed() {
    let _turn = SERIAL.lock().await;
    opensesame_event_seal::clear();
    let db = db_without_parents().await;
    // SQLite's LIKE ignores case, so a `NOT LIKE 'osev1.%'` sweep skipped this.
    let upper = "OSEV1.looks-sealed-but-is-not";
    db.append_outbox("legacy.upper", upper).await.unwrap();
    opensesame_event_seal::install(&KEY);
    assert_eq!(db.seal_legacy_events().await.unwrap(), 1);
    let stored = raw(&db, "SELECT payload_json FROM outbox_events").await;
    assert!(stored.starts_with("osev1.") && !stored.contains("looks-sealed"));
    assert_eq!(
        db.claim_outbox_batch(10, 30).await.unwrap()[0].payload_json,
        upper
    );
    opensesame_event_seal::clear();
}

#[tokio::test]
async fn failure_text_an_older_build_stored_as_it_came_is_scrubbed_once() {
    let _turn = SERIAL.lock().await;
    opensesame_event_seal::clear();
    let db = db_without_parents().await;
    let id = db.append_outbox("legacy.event", "{}").await.unwrap();
    db.enqueue_security_delivery(&delivery("d-legacy", "{}"))
        .await
        .unwrap();
    let leaky = "POST https://hook.example/x?token=abc123 refused";
    sqlx::query("UPDATE outbox_events SET last_error = ? WHERE id = ?")
        .bind(leaky)
        .bind(&id)
        .execute(db.pool())
        .await
        .unwrap();
    sqlx::query("UPDATE security_deliveries SET last_error = ?")
        .bind(leaky)
        .execute(db.pool())
        .await
        .unwrap();

    assert_eq!(db.scrub_legacy_failure_text().await.unwrap(), 2);
    for sql in [
        "SELECT last_error FROM outbox_events",
        "SELECT last_error FROM security_deliveries",
    ] {
        let text = raw(&db, sql).await;
        assert!(
            !text.contains("abc123") && text.contains("refused"),
            "{text}"
        );
    }
    assert_eq!(
        db.scrub_legacy_failure_text().await.unwrap(),
        0,
        "a second pass finds nothing"
    );
}
