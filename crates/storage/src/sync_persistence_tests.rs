//! Encrypted sync persistence, atomicity, and numeric storage boundaries.
use super::*;

#[tokio::test]
async fn encrypted_sync_survives_new_db_handles_and_is_owner_scoped() {
    let db = Db::connect_memory().await.unwrap();
    let blob = StoredSyncBlob {
        id: "vault-1".into(),
        epoch: 7,
        ciphertext: vec![1, 2, 3],
    };
    assert_eq!(
        db.write_sync_blob("principal:alice", &blob, 10, 5)
            .await
            .unwrap(),
        SyncWriteOutcome::Accepted
    );
    assert_eq!(
        db.write_sync_blob("principal:bob", &blob, 10, 5)
            .await
            .unwrap(),
        SyncWriteOutcome::ForeignOwner
    );
    assert_eq!(
        db.write_sync_blob("principal:alice", &blob, 10, 5)
            .await
            .unwrap(),
        SyncWriteOutcome::Accepted
    );
    // Exact retries are idempotent; equal-epoch replacement is still refused.
    let conflicting = StoredSyncBlob {
        ciphertext: vec![9, 9, 9],
        ..blob.clone()
    };
    assert_eq!(
        db.write_sync_blob("principal:alice", &conflicting, 10, 5)
            .await
            .unwrap(),
        SyncWriteOutcome::StaleEpoch
    );
    assert_eq!(
        db.list_sync_blobs("principal:alice", 0).await.unwrap(),
        vec![blob]
    );
    assert!(db
        .list_sync_blobs("principal:bob", 0)
        .await
        .unwrap()
        .is_empty());
    assert_eq!(
        db.advance_sync_cursor("principal:alice", "device", 7, 1)
            .await
            .unwrap(),
        Some(7)
    );
    assert_eq!(
        db.advance_sync_cursor("principal:alice", "another-device", 7, 1)
            .await
            .unwrap(),
        None
    );
    assert_eq!(
        db.advance_sync_cursor("principal:alice", "device", 9, 1)
            .await
            .unwrap(),
        Some(9)
    );
}

#[tokio::test]
async fn encrypted_sync_batch_is_atomic_on_equal_epoch_conflict() {
    let db = Db::connect_memory().await.unwrap();
    let header = StoredSyncBlob {
        id: "vault:header".into(),
        epoch: 1,
        ciphertext: vec![1],
    };
    let body = StoredSyncBlob {
        id: "vault:body".into(),
        epoch: 1,
        ciphertext: vec![2],
    };
    assert_eq!(
        db.write_sync_blobs("owner", &[header.clone(), body.clone()], 10, 10)
            .await
            .unwrap(),
        vec![SyncWriteOutcome::Accepted, SyncWriteOutcome::Accepted]
    );

    let conflicting_header = StoredSyncBlob {
        ciphertext: vec![9],
        ..header
    };
    let newer_body = StoredSyncBlob {
        epoch: 2,
        ciphertext: vec![8],
        ..body
    };
    assert_eq!(
        db.write_sync_blobs("owner", &[conflicting_header, newer_body], 10, 10)
            .await
            .unwrap(),
        vec![SyncWriteOutcome::StaleEpoch, SyncWriteOutcome::BatchAborted]
    );
    let stored = db.list_sync_blobs("owner", 0).await.unwrap();
    assert_eq!(stored.len(), 2);
    assert!(stored.iter().all(|blob| blob.epoch == 1));
    assert!(stored
        .iter()
        .any(|blob| blob.id == "vault:body" && blob.ciphertext == vec![2]));
}

#[test]
fn database_unsigned_values_reject_negative_storage() {
    assert_eq!(db_u64(0, "epoch").unwrap(), 0);
    assert_eq!(
        db_u64(i64::MAX, "epoch").unwrap(),
        u64::try_from(i64::MAX).unwrap()
    );
    assert!(db_u64(-1, "epoch").is_err());
}

#[tokio::test]
async fn sync_epoch_boundaries_fail_closed() {
    let db = Db::connect_memory().await.unwrap();
    let too_large = StoredSyncBlob {
        id: "too-large".into(),
        epoch: u64::try_from(i64::MAX).unwrap() + 1,
        ciphertext: vec![1],
    };
    assert!(db
        .write_sync_blob("owner", &too_large, 10, 10)
        .await
        .is_err());

    sqlx::query(
        "INSERT INTO encrypted_sync_blobs (id, owner_id, epoch, ciphertext, updated_at) \
         VALUES ('corrupt', 'owner', -1, X'01', 't')",
    )
    .execute(db.pool())
    .await
    .unwrap();
    assert!(db.list_sync_backup_page(None).await.is_err());
}
