//! Persistence for an already validated batch, within the caller's transaction.
use crate::{append_outbox_tx, append_sync_blob_outbox, StoredSyncBlob, Utc};

pub(super) async fn persist_batch(
    transaction: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    owner_id: &str,
    organization_id: &str,
    blobs: &[StoredSyncBlob],
    epochs: &[i64],
    existing: &[bool],
) -> anyhow::Result<()> {
    let ingestion_epoch: i64 = sqlx::query_scalar("UPDATE sync_ingestion_clock SET epoch = epoch + 1 WHERE singleton = 1 AND epoch < 9223372036854775807 RETURNING epoch")
        .fetch_one(&mut **transaction).await?;
    let updated_at = Utc::now().to_rfc3339();
    for ((blob, &epoch), &exists) in blobs.iter().zip(epochs).zip(existing) {
        if exists {
            sqlx::query(
                "UPDATE encrypted_sync_blobs SET epoch = ?, ciphertext = ?, updated_at = ?, ingestion_epoch = ? WHERE id = ? AND owner_id = ? AND organization_id = ?",
            )
            .bind(epoch)
            .bind(&blob.ciphertext)
            .bind(&updated_at)
            .bind(ingestion_epoch)
            .bind(&blob.id)
            .bind(owner_id)
            .bind(organization_id)
            .execute(&mut **transaction)
            .await?;
        } else {
            sqlx::query(
                "INSERT INTO encrypted_sync_blobs (id, owner_id, epoch, ciphertext, updated_at, organization_id, ingestion_epoch) VALUES (?, ?, ?, ?, ?, ?, ?)",
            )
            .bind(&blob.id)
            .bind(owner_id)
            .bind(epoch)
            .bind(&blob.ciphertext)
            .bind(&updated_at)
            .bind(organization_id)
            .bind(ingestion_epoch)
            .execute(&mut **transaction)
            .await?;
        }
        if organization_id.is_empty() {
            append_sync_blob_outbox(transaction, owner_id, &blob.id, epoch).await?;
        } else {
            append_outbox_tx(transaction, "sync.blob.written", &serde_json::json!({
                "owner_id":owner_id,"organization_id":organization_id,"blob_id":blob.id,"epoch":epoch
            }).to_string()).await?;
        }
    }
    Ok(())
}
