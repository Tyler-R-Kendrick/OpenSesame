//! Migration 0053 rebuilds `agent_hook_records` with a foreign key onto the
//! observation run. A host that already holds records keeps every record
//! whose run exists in the same organization, drops the ones nothing owns,
//! and from then on a run's removal takes its records with it.
use super::*;

const INSERT_RUN: &str = "INSERT INTO observation_runs (id, organization_id, job_id, \
    target_origin, tier, control_state, owner_principal_id, viewer_key_id, expires_at, \
    created_at, updated_at) VALUES (?, ?, 'job:1', 'https://example.com', 't3', \
    'agent_driving', 'user:alice', 'xkey:1', '2099-01-01T00:00:00Z', \
    '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')";

const INSERT_RECORD: &str = "INSERT INTO agent_hook_records (run_id, organization_id, sequence, \
    interception_point, decision, escalated, policy_version, recorded_at) \
    VALUES (?, ?, ?, 'pre_tool_call', 'allow', 0, 1, '2026-01-01T00:00:00Z')";

async fn schema_before_run_fk() -> Db {
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect("sqlite::memory:")
        .await
        .unwrap();
    let upto = MIGRATIONS
        .iter()
        .position(|(v, _)| *v == "0053_agent_hook_records_run_fk")
        .unwrap();
    apply_migrations(&pool, &MIGRATIONS[..upto]).await;
    sqlx::query(
        "CREATE TABLE schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL)",
    )
    .execute(&pool)
    .await
    .unwrap();
    for (version, _) in &MIGRATIONS[..upto] {
        sqlx::query("INSERT INTO schema_migrations VALUES (?, 'previous-boot')")
            .bind(version)
            .execute(&pool)
            .await
            .unwrap();
    }
    for run in ["run:real", "run:other-tenant"] {
        sqlx::query(INSERT_RUN)
            .bind(run)
            .bind("org:one")
            .execute(&pool)
            .await
            .unwrap();
    }
    // Under the old schema a record could name any run at all: one that was
    // never opened, and one that belongs to another organization.
    for (run, org, sequence) in [
        ("run:real", "org:one", 0_i64),
        ("run:real", "org:one", 1),
        ("run:gone", "org:one", 0),
        ("run:other-tenant", "org:two", 7),
    ] {
        sqlx::query(INSERT_RECORD)
            .bind(run)
            .bind(org)
            .bind(sequence)
            .execute(&pool)
            .await
            .unwrap();
    }
    Db { pool }
}

async fn count(db: &Db, run: &str) -> i64 {
    sqlx::query_scalar("SELECT COUNT(*) FROM agent_hook_records WHERE run_id = ?")
        .bind(run)
        .fetch_one(db.pool())
        .await
        .unwrap()
}

#[tokio::test]
async fn the_rebuild_keeps_only_records_whose_run_exists_in_their_organization() {
    let db = schema_before_run_fk().await;
    db.migrate().await.unwrap();
    assert_eq!(db.applied_migrations().await.unwrap(), migration_versions());

    assert_eq!(count(&db, "run:real").await, 2, "the run's records survive");
    assert_eq!(count(&db, "run:gone").await, 0, "no run, no record");
    assert_eq!(
        count(&db, "run:other-tenant").await,
        0,
        "that run is org:one's, the record says org:two"
    );
    let kept = db.agent_hook_records("org:one", "run:real").await.unwrap();
    assert_eq!(kept.iter().map(|r| r.sequence).collect::<Vec<_>>(), [0, 1]);
    assert_eq!(kept[0].policy_version, 1);
    assert_eq!(kept[0].interception_point, "pre_tool_call");

    db.migrate().await.unwrap();
    assert_eq!(
        count(&db, "run:real").await,
        2,
        "re-running changes nothing"
    );
}

#[tokio::test]
async fn after_the_rebuild_a_record_needs_its_run_and_goes_with_it() {
    let db = schema_before_run_fk().await;
    db.migrate().await.unwrap();

    for (run, org) in [("run:gone", "org:one"), ("run:real", "org:two")] {
        let refused = sqlx::query(INSERT_RECORD)
            .bind(run)
            .bind(org)
            .bind(9_i64)
            .execute(db.pool())
            .await;
        assert!(refused.is_err(), "{run} in {org} has no parent run");
    }

    sqlx::query("DELETE FROM observation_runs WHERE id = 'run:real'")
        .execute(db.pool())
        .await
        .unwrap();
    assert_eq!(count(&db, "run:real").await, 0, "the cascade took them");

    // The index the readers rely on survives the swap, and the old table's
    // name is the only one left.
    let tables: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM sqlite_master WHERE name IN \
         ('agent_hook_records', 'idx_agent_hook_records_org')",
    )
    .fetch_one(db.pool())
    .await
    .unwrap();
    assert_eq!(tables, 2);
    let leftover: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM sqlite_master WHERE name = 'agent_hook_records_v2'",
    )
    .fetch_one(db.pool())
    .await
    .unwrap();
    assert_eq!(leftover, 0);
}
