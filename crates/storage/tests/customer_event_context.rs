//! The Host's event rows rest sealed (ADR 0157). Every assertion reads the
//! table itself, not the API: what a copied database file would show.

use opensesame_storage::{Db, StoredSecurityDelivery};
use sqlx::Row as _;

/// The sealer is process-wide; tests that install it take turns.
static SERIAL: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
const KEY: [u8; 32] = [7; 32];

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
async fn tenant_events_refuse_customer_and_row_substitution() {
    let _turn = SERIAL.lock().await;
    opensesame_event_seal::install(&KEY);
    let db = db_without_parents().await;
    db.enqueue_security_delivery(&delivery("d-1", "{\"note\":\"secret\"}"))
        .await
        .unwrap();
    sqlx::query("UPDATE security_deliveries SET organization_id = 'org-2' WHERE id = 'd-1'")
        .execute(db.pool())
        .await
        .unwrap();
    assert!(db.list_security_deliveries("org-2", 10).await.is_err());
    sqlx::query(
        "UPDATE security_deliveries SET organization_id = 'org-1', id = 'd-2' WHERE id = 'd-1'",
    )
    .execute(db.pool())
    .await
    .unwrap();
    assert!(db.list_security_deliveries("org-1", 10).await.is_err());

    let id = db
        .append_outbox(
            "test.event",
            "{\"organization_id\":\"org-1\",\"note\":\"secret\"}",
        )
        .await
        .unwrap();
    sqlx::query("UPDATE outbox_events SET organization_id = 'org-2' WHERE id = ?")
        .bind(id)
        .execute(db.pool())
        .await
        .unwrap();
    assert!(db.claim_outbox_batch(10, 30).await.unwrap().is_empty());
    opensesame_event_seal::clear();
}

#[tokio::test]
async fn outbox_customer_migration_accepts_encrypted_and_non_json_legacy_rows() {
    let db = db_without_parents().await;
    sqlx::query("DROP TABLE outbox_events")
        .execute(db.pool())
        .await
        .unwrap();
    sqlx::query("CREATE TABLE outbox_events (id TEXT PRIMARY KEY, payload_json TEXT NOT NULL)")
        .execute(db.pool())
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO vaults (id, organization_id, created_at) VALUES ('vault-a', 'org-a', 'now')",
    )
    .execute(db.pool())
    .await
    .unwrap();
    for (id, payload) in [
        ("encrypted", "osev1.legacy-ciphertext"),
        ("plain", "not-json"),
        ("organization", r#"{"organization_id":"org-a"}"#),
        ("vault", r#"{"vault_id":"vault-a"}"#),
    ] {
        sqlx::query("INSERT INTO outbox_events (id, payload_json) VALUES (?, ?)")
            .bind(id)
            .bind(payload)
            .execute(db.pool())
            .await
            .unwrap();
    }
    for statement in include_str!("../migrations/0056_outbox_customer_binding.sql").split(';') {
        if !statement.trim().is_empty() {
            sqlx::query(statement).execute(db.pool()).await.unwrap();
        }
    }
    let rows = sqlx::query("SELECT id, organization_id FROM outbox_events ORDER BY id")
        .fetch_all(db.pool())
        .await
        .unwrap();
    for row in rows {
        let id: String = row.get("id");
        let customer: Option<String> = row.get("organization_id");
        assert_eq!(
            customer.as_deref(),
            if id == "organization" || id == "vault" {
                Some("org-a")
            } else {
                None
            }
        );
    }
}

#[tokio::test]
async fn legacy_event_sweep_matches_connection_and_delivery_contexts() {
    let _turn = SERIAL.lock().await;
    opensesame_event_seal::clear();
    let db = db_without_parents().await;
    sqlx::query("INSERT INTO connections (id, organization_id, provider_id, logical_name, display_name, status, requested_scopes, granted_scopes, owner_kind, shareability, max_invoke_level, egress_json, created_at, updated_at) VALUES ('conn-1', 'org-1', 'p', 'test', 'test', 'active', '[]', '[]', 'human', 'private', 1, '{}', 'now', 'now')")
        .execute(db.pool()).await.unwrap();
    sqlx::query("INSERT INTO connection_events (id, connection_id, kind, detail, at) VALUES ('ev-1', 'conn-1', 'test', 'secret-detail', 'now')")
        .execute(db.pool()).await.unwrap();
    db.enqueue_security_delivery(&delivery("d-1", "{}"))
        .await
        .unwrap();
    opensesame_event_seal::install(&KEY);
    assert_eq!(db.seal_legacy_events().await.unwrap(), 2);
    let stored = raw(&db, "SELECT detail FROM connection_events").await;
    assert_eq!(
        opensesame_event_seal::open_in(
            "org-1",
            "connection_events.detail",
            "6:conn-1ev-1",
            &stored
        )
        .unwrap(),
        "secret-detail"
    );
    assert!(opensesame_event_seal::open_in(
        "org-2",
        "connection_events.detail",
        "6:conn-1ev-1",
        &stored
    )
    .is_err());
    assert_eq!(
        db.list_security_deliveries("org-1", 10).await.unwrap()[0].payload_json,
        "{}"
    );
    assert_eq!(db.seal_legacy_events().await.unwrap(), 0);
    // Once startup migration finishes, replacing a row with its old plaintext
    // must fail through the production reader, rather than silently reimporting it.
    sqlx::query("UPDATE security_deliveries SET payload_json = '{}' WHERE id = 'd-1'")
        .execute(db.pool())
        .await
        .unwrap();
    assert!(db.list_security_deliveries("org-1", 10).await.is_err());
    sqlx::query("UPDATE security_deliveries SET payload_json = 'osev1.replayed' WHERE id = 'd-1'")
        .execute(db.pool())
        .await
        .unwrap();
    assert!(db.list_security_deliveries("org-1", 10).await.is_err());
    opensesame_event_seal::clear();
}

#[tokio::test]
async fn ordinary_restart_refuses_legacy_replay_without_reimporting() {
    let _turn = SERIAL.lock().await;
    opensesame_event_seal::clear();
    let db = db_without_parents().await;
    db.enqueue_security_delivery(&delivery("restart", r#"{"saved":"legacy"}"#))
        .await
        .unwrap();
    opensesame_event_seal::install(&KEY);
    assert!(db.validate_current_event_envelopes().await.is_err());
    assert_eq!(
        raw(&db, "SELECT payload_json FROM security_deliveries").await,
        r#"{"saved":"legacy"}"#
    );
    // Explicit trusted import remains compatible; ordinary startup never calls it.
    assert_eq!(db.seal_legacy_events().await.unwrap(), 1);
    db.validate_current_event_envelopes().await.unwrap();
    // A copied database attacker can also bypass application/schema checks.
    sqlx::query("PRAGMA ignore_check_constraints = ON")
        .execute(db.pool())
        .await
        .unwrap();
    for legacy in [r#"{"saved":"legacy"}"#, "osev1.saved-ciphertext", ""] {
        sqlx::query(
            "UPDATE security_deliveries SET organization_id = 'other-customer', payload_json = ?",
        )
        .bind(legacy)
        .execute(db.pool())
        .await
        .unwrap();
        opensesame_event_seal::install(&KEY);
        assert!(db.validate_current_event_envelopes().await.is_err());
        assert_eq!(
            raw(&db, "SELECT payload_json FROM security_deliveries").await,
            legacy
        );
        assert!(db
            .list_security_deliveries("other-customer", 10)
            .await
            .is_err());
    }
    // Empty legacy values also receive an envelope during explicit import.
    assert_eq!(db.seal_legacy_events().await.unwrap(), 1);
    db.validate_current_event_envelopes().await.unwrap();
    opensesame_event_seal::clear();
}
