use opensesame_storage::{Db, StoredSyncBlob, SyncWriteOutcome};

async fn store() -> Db {
    let db = Db::connect_memory().await.unwrap();
    migrate(&db).await;
    db
}

async fn migrate(db: &Db) {
    // Supports the pre-integration migration registry as well as the final registry.
    let columns: Vec<(i64, String, String, i64, Option<String>, i64)> =
        sqlx::query_as("PRAGMA table_info(encrypted_sync_blobs)")
            .fetch_all(db.pool())
            .await
            .unwrap();
    if !columns.iter().any(|column| column.1 == "organization_id") {
        sqlx::raw_sql(include_str!(
            "../../../migrations/0028_sync_organization_scope.sql"
        ))
        .execute(db.pool())
        .await
        .unwrap();
    }
}

#[tokio::test]
async fn ingestion_sequence_survives_restart_and_exact_retry_is_idempotent() {
    let path = std::env::temp_dir().join(format!(
        "opensesame-sync-test-{}.sqlite",
        uuid::Uuid::new_v4()
    ));
    let url = format!("sqlite:{}?mode=rwc", path.display());
    let db = Db::connect_sqlite(&url).await.unwrap();
    migrate(&db).await;
    write(&db, "org:a", "z", 100, 4).await;
    let (first, _) = db
        .list_sync_blobs_page("principal:alice", "org:a", (0, ""), 32, false)
        .await
        .unwrap();
    let cursor = (first[0].sequence, first[0].blob.id.clone());
    write(&db, "org:a", "z", 100, 4).await;
    assert!(db
        .list_sync_blobs_page("principal:alice", "org:a", (cursor.0, &cursor.1), 32, false)
        .await
        .unwrap()
        .0
        .is_empty());
    db.pool().close().await;
    let db = Db::connect_sqlite(&url).await.unwrap();
    write(&db, "org:a", "a", 1, 4).await;
    let (next, _) = db
        .list_sync_blobs_page("principal:alice", "org:a", (cursor.0, &cursor.1), 32, false)
        .await
        .unwrap();
    assert_eq!(next[0].blob.id, "a");
    assert_eq!(next[0].blob.epoch, 1);
    assert!(next[0].sequence > cursor.0);
    db.pool().close().await;
    std::fs::remove_file(path).unwrap();
}

async fn write(db: &Db, org: &str, id: &str, epoch: u64, size: usize) {
    let outcome = db
        .write_sync_blobs_scoped(
            "principal:alice",
            org,
            &[StoredSyncBlob {
                id: id.into(),
                epoch,
                ciphertext: vec![255; size],
            }],
            4096,
            512,
        )
        .await
        .unwrap();
    assert_eq!(outcome, vec![SyncWriteOutcome::Accepted]);
}

#[tokio::test]
async fn equal_epochs_continue_without_duplicate_or_skip() {
    let db = store().await;
    let batch: Vec<_> = ["a", "b", "c", "d", "e"]
        .into_iter()
        .map(|id| StoredSyncBlob {
            id: id.into(),
            epoch: 7,
            ciphertext: vec![255; 4],
        })
        .collect();
    db.write_sync_blobs_scoped("principal:alice", "org:a", &batch, 4096, 512)
        .await
        .unwrap();
    let (first, more) = db
        .list_sync_blobs_page("principal:alice", "org:a", (0, ""), 2, false)
        .await
        .unwrap();
    assert!(more);
    assert_eq!(
        first.iter().map(|b| b.blob.id.as_str()).collect::<Vec<_>>(),
        vec!["a", "b"]
    );
    let (second, more) = db
        .list_sync_blobs_page("principal:alice", "org:a", (1, "b"), 2, false)
        .await
        .unwrap();
    assert!(more);
    assert_eq!(
        second
            .iter()
            .map(|b| b.blob.id.as_str())
            .collect::<Vec<_>>(),
        vec!["c", "d"]
    );
    let (last, more) = db
        .list_sync_blobs_page("principal:alice", "org:a", (1, "d"), 2, false)
        .await
        .unwrap();
    assert!(!more);
    assert_eq!(last[0].blob.id, "e");
}

#[tokio::test]
async fn organization_and_owner_are_query_predicates() {
    let db = store().await;
    write(&db, "org:a", "a", 7, 4).await;
    write(&db, "org:b", "a", 8, 4).await;
    let (rows, _) = db
        .list_sync_blobs_page("principal:alice", "org:a", (0, ""), 32, false)
        .await
        .unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].blob.epoch, 7);
    let (foreign, _) = db
        .list_sync_blobs_page("principal:bob", "org:a", (0, ""), 32, false)
        .await
        .unwrap();
    assert!(foreign.is_empty());
    let (backup, more) = db
        .list_sync_backup_page_scoped("org:a", None)
        .await
        .unwrap();
    assert!(!more);
    assert_eq!(backup.len(), 1);
    assert_eq!(backup[0].0, "org:a");
    assert_eq!(backup[0].2.blob.epoch, 7);
    assert!(db.list_sync_backup_page_scoped("", None).await.is_err());
}

#[tokio::test]
async fn byte_budget_stops_before_loading_all_ciphertext() {
    let db = store().await;
    for id in ["a", "b", "c", "d"] {
        write(&db, "org:a", id, 7, 2 * 1024 * 1024).await;
    }
    let (rows, more) = db
        .list_sync_blobs_page("principal:alice", "org:a", (0, ""), 64, false)
        .await
        .unwrap();
    assert!(more);
    assert_eq!(rows.len(), 2);
    assert!(
        rows.iter()
            .map(|row| row.blob.ciphertext.len().div_ceil(3) * 4 + row.blob.id.len() * 6 + 256)
            .sum::<usize>()
            < 8 * 1024 * 1024
    );
    assert!(db
        .list_sync_blobs_page("principal:alice", "org:a", (0, ""), 64, true)
        .await
        .is_err());
}

#[tokio::test]
async fn later_insert_is_visible_after_the_cursor() {
    let db = store().await;
    write(&db, "org:a", "a", 7, 4).await;
    let (first, _) = db
        .list_sync_blobs_page("principal:alice", "org:a", (0, ""), 1, false)
        .await
        .unwrap();
    write(&db, "org:a", "0-backdated", 1, 4).await;
    let (next, _) = db
        .list_sync_blobs_page(
            "principal:alice",
            "org:a",
            (first[0].sequence, &first[0].blob.id),
            1,
            false,
        )
        .await
        .unwrap();
    assert_eq!(next[0].blob.id, "0-backdated");
    assert_eq!(next[0].blob.epoch, 1);
    assert!(next[0].sequence > first[0].sequence);
}

#[tokio::test]
async fn legacy_ciphertext_stays_quarantined_and_intact() {
    let db = store().await;
    write(&db, "", "legacy", 7, 4).await;
    let (network, _) = db
        .list_sync_blobs_page("principal:alice", "org:a", (0, ""), 32, false)
        .await
        .unwrap();
    assert!(network.is_empty());
    let (legacy, _) = db
        .list_sync_blobs_page("principal:alice", "", (0, ""), 32, false)
        .await
        .unwrap();
    assert_eq!(legacy[0].blob.ciphertext, vec![255; 4]);
}

#[tokio::test]
async fn offline_rebind_is_explicit_atomic_and_owner_checked() {
    let db = store().await;
    let owner = opensesame_domain::PrincipalId::new();
    let org = opensesame_domain::OrganizationId::new();
    sqlx::query(
        "INSERT INTO organizations(id,name,created_at) VALUES (?,'verified organization','now')",
    )
    .bind(org.to_string())
    .execute(db.pool())
    .await
    .unwrap();
    let blob = StoredSyncBlob {
        id: "chosen".into(),
        epoch: 7,
        ciphertext: vec![1, 2, 3],
    };
    db.write_sync_blobs(&owner.to_string(), std::slice::from_ref(&blob), 4096, 512)
        .await
        .unwrap();
    let evidence = "a".repeat(64);
    let selected = vec![("chosen".into(), 7), ("missing".into(), 7)];
    assert!(db
        .rebind_legacy_sync_blobs(&owner, &org, &selected, &evidence)
        .await
        .is_err());
    let (original, _) = db
        .list_sync_blobs_page(&owner.to_string(), "", (0, ""), 32, false)
        .await
        .unwrap();
    assert_eq!(original[0].blob, blob.clone());
    let wrong = opensesame_domain::PrincipalId::new();
    assert!(db
        .rebind_legacy_sync_blobs(&wrong, &org, &selected[..1], &evidence)
        .await
        .is_err());
    assert_eq!(
        db.rebind_legacy_sync_blobs(&owner, &org, &selected[..1], &evidence)
            .await
            .unwrap(),
        1
    );
    let (bound, _) = db
        .list_sync_blobs_page(&owner.to_string(), &org.to_string(), (0, ""), 32, false)
        .await
        .unwrap();
    assert_eq!(bound[0].blob, blob);
    assert!(db
        .rebind_legacy_sync_blobs(&owner, &org, &selected[..1], &evidence)
        .await
        .is_err());
}

#[tokio::test]
async fn backup_cursor_keeps_organization_namespaces_distinct() {
    let db = store().await;
    write(&db, "org:a", "same-id", 7, 4).await;
    write(&db, "org:b", "same-id", 7, 4).await;
    let (page, more) = db.list_sync_backup_page(None).await.unwrap();
    assert!(!more);
    assert_eq!(page.len(), 2);
    assert_eq!(page[0].0, "org:a");
    assert_eq!(page[1].0, "org:b");
}
