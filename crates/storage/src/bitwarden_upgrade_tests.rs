//! Migration 0045 rebuilds `bitwarden_ciphers` (a cipher may now belong to an
//! organization) and puts `bitwarden_attachments` back around it. A server
//! that already holds ciphers and files keeps every row and every byte, and
//! the cascades still take a cipher's files with it.
use super::*;

async fn schema_before_organizations() -> Db {
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect("sqlite::memory:")
        .await
        .unwrap();
    let upto = MIGRATIONS
        .iter()
        .position(|(v, _)| *v == "0045_bitwarden_organizations")
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
    for statement in [
        "INSERT INTO bitwarden_users (id, email, master_password_hash, kdf_type, kdf_iterations, \
         user_key, security_stamp, created_at, revision_at, updated_at) VALUES ('u1', \
         'a@example.com', 'h', 0, 600000, '2.k', 's', '2026-01-01T00:00:00Z', \
         '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
        "INSERT INTO bitwarden_ciphers (id, user_id, cipher_type, data, created_at, revision_at) \
         VALUES ('c1', 'u1', 2, '{}', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
        "INSERT INTO bitwarden_attachments (id, cipher_id, user_id, file_name, key, size, uploaded, \
         created_at) VALUES ('a1', 'c1', 'u1', '2.n', '2.k', 3, 1, '2026-01-01T00:00:00Z')",
        "INSERT INTO bitwarden_blobs (id, data) VALUES ('a1', x'010203')",
    ] {
        sqlx::query(statement).execute(&pool).await.unwrap();
    }
    Db { pool }
}

#[tokio::test]
async fn organizations_upgrade_keeps_ciphers_files_and_cascades() {
    let db = schema_before_organizations().await;
    db.migrate().await.unwrap();
    assert_eq!(db.applied_migrations().await.unwrap(), migration_versions());

    let ciphers = db.bitwarden_ciphers("u1").await.unwrap();
    assert_eq!(ciphers.len(), 1);
    assert_eq!(ciphers[0].user_id.as_deref(), Some("u1"));
    assert_eq!(ciphers[0].organization_id, None);
    let files = db.bitwarden_attachments("u1").await.unwrap();
    assert_eq!(files.len(), 1);
    assert_eq!(files[0].cipher_id, "c1");
    assert_eq!(db.bitwarden_blob("a1").await.unwrap(), Some(vec![1, 2, 3]));
    let kept: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM sqlite_master WHERE name = 'bitwarden_attachments_kept'",
    )
    .fetch_one(db.pool())
    .await
    .unwrap();
    assert_eq!(kept, 0);

    // The rebuilt tables still cascade: a cipher's files and bytes go with it.
    assert_eq!(
        db.bitwarden_delete_ciphers("u1", &["c1".to_owned()])
            .await
            .unwrap(),
        1
    );
    assert!(db.bitwarden_attachments("u1").await.unwrap().is_empty());
    assert_eq!(db.bitwarden_blob("a1").await.unwrap(), None);
}
