use chrono::Utc;

use super::{BitwardenAttachment, BitwardenCipherShare, BitwardenStorageQuotaExceeded};
use crate::Db;

async fn fixture() -> Db {
    fixture_in(Db::connect_memory().await.unwrap()).await
}

async fn fixture_in(db: Db) -> Db {
    for statement in [
        "INSERT INTO bitwarden_users (id, email, master_password_hash, kdf_type, kdf_iterations, \
         user_key, security_stamp, created_at, revision_at, updated_at) VALUES ('u', \
         'quota@example.com', 'h', 0, 600000, '2.k', 's', '2026-01-01T00:00:00.000Z', \
         '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')",
        "INSERT INTO bitwarden_organizations (id, name, billing_email, created_at, revision_at) \
         VALUES ('o', 'Org', 'billing@example.com', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')",
        "INSERT INTO bitwarden_ciphers (id, user_id, cipher_type, data, created_at, revision_at) \
         VALUES ('c1', 'u', 2, '{}', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'), \
         ('c2', 'u', 2, '{}', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')",
    ] {
        sqlx::query(statement).execute(&db.pool).await.unwrap();
    }
    db
}

fn attachment(cipher: &str, size: i64) -> BitwardenAttachment {
    BitwardenAttachment {
        id: format!("a-{cipher}"),
        cipher_id: cipher.to_owned(),
        user_id: Some("u".to_owned()),
        file_name: "2.name".to_owned(),
        key: Some("2.key".to_owned()),
        size,
        uploaded: false,
        created_at: Utc::now(),
    }
}

async fn share(db: &Db, id: &str) -> BitwardenCipherShare {
    let mut cipher = db.bitwarden_cipher_any(id).await.unwrap().unwrap();
    let expected_revision = cipher.revision_at;
    cipher.user_id = None;
    cipher.organization_id = Some("o".to_owned());
    cipher.revision_at = Utc::now();
    BitwardenCipherShare {
        cipher,
        expected_revision,
        collection_ids: Vec::new(),
    }
}

#[tokio::test]
async fn sharing_counts_actual_bytes_and_pending_claims_and_rolls_back_the_batch() {
    let db = fixture().await;
    let first = attachment("c1", 2);
    db.bitwarden_add_attachment(&first, 100).await.unwrap();
    db.bitwarden_upload_attachment_of("c1", &first.id, &[1; 7], 100)
        .await
        .unwrap();
    db.bitwarden_add_attachment(&attachment("c2", 4), 100)
        .await
        .unwrap();
    assert_eq!(db.bitwarden_storage_used("u").await.unwrap(), 11);
    let shares = [share(&db, "c1").await, share(&db, "c2").await];
    let error = db
        .bitwarden_share_ciphers("u", &shares, 10)
        .await
        .unwrap_err();
    assert!(error.is::<BitwardenStorageQuotaExceeded>());
    assert_eq!(db.bitwarden_org_storage_used("o").await.unwrap(), 0);
    assert_eq!(db.bitwarden_storage_used("u").await.unwrap(), 11);
    assert!(db.bitwarden_share_ciphers("u", &shares, 11).await.unwrap());
    assert_eq!(db.bitwarden_org_storage_used("o").await.unwrap(), 11);
    assert_eq!(db.bitwarden_storage_used("u").await.unwrap(), 0);
}

#[tokio::test]
async fn concurrent_transfers_cannot_overfill_the_destination() {
    let path =
        std::env::temp_dir().join(format!("opensesame-quota-{}.sqlite", uuid::Uuid::new_v4()));
    std::fs::File::create(&path).unwrap();
    let db = fixture_in(
        Db::connect_sqlite(&format!("sqlite:{}", path.display()))
            .await
            .unwrap(),
    )
    .await;
    db.bitwarden_add_attachment(&attachment("c1", 6), 100)
        .await
        .unwrap();
    db.bitwarden_add_attachment(&attachment("c2", 6), 100)
        .await
        .unwrap();
    let first = [share(&db, "c1").await];
    let second = [share(&db, "c2").await];
    let (a, b) = tokio::join!(
        db.bitwarden_share_ciphers("u", &first, 10),
        db.bitwarden_share_ciphers("u", &second, 10),
    );
    assert_eq!(usize::from(a.is_ok()) + usize::from(b.is_ok()), 1);
    assert!(a
        .err()
        .or_else(|| b.err())
        .unwrap()
        .is::<BitwardenStorageQuotaExceeded>());
    assert_eq!(db.bitwarden_org_storage_used("o").await.unwrap(), 6);
    db.pool.close().await;
    std::fs::remove_file(path).unwrap();
}

#[tokio::test]
async fn rekey_and_upload_growth_cannot_bypass_quota_or_use_stale_personal_ownership() {
    let db = fixture().await;
    let mut file = attachment("c1", 5);
    db.bitwarden_add_attachment(&file, 5).await.unwrap();
    let error = db
        .bitwarden_upload_attachment_of("c1", &file.id, &[1; 6], 5)
        .await
        .unwrap_err();
    assert!(error.is::<BitwardenStorageQuotaExceeded>());
    file.size = 6;
    let error = db
        .bitwarden_rekey_attachment("u", &file, &[2; 6], 5)
        .await
        .unwrap_err();
    assert!(error.is::<BitwardenStorageQuotaExceeded>());
    assert!(db.bitwarden_blob(&file.id).await.unwrap().is_none());
    let shares = [share(&db, "c1").await];
    assert!(db.bitwarden_share_ciphers("u", &shares, 5).await.unwrap());
    assert!(!db
        .bitwarden_rekey_attachment("u", &file, &[2; 6], 100)
        .await
        .unwrap());
    assert_eq!(db.bitwarden_org_storage_used("o").await.unwrap(), 5);
    assert!(db.bitwarden_blob(&file.id).await.unwrap().is_none());
}
