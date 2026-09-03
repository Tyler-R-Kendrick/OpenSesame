//! Client-plane E2EE sync blobs, cursors and encrypted item revisions.
//!
//! Split out of the single `impl Db` block in `lib.rs`, which had grown to
//! 215 methods across 5,292 lines. Rust spreads a type's inherent impl over
//! any number of modules in the same crate, so this is a pure move: no
//! signature, visibility or call site changes.

use super::{
    append_outbox_tx, append_sync_blob_outbox, db_u64, Context, Db, EncryptedItemRevision, Row,
    StoredSyncBlob, SyncWriteOutcome, Utc,
};

impl Db {
    /// Atomically persist an encrypted item revision and its outbox event.
    ///
    /// # Errors
    ///
    /// Returns an error when insertion, outbox creation, or transaction commit
    /// fails.
    pub async fn insert_encrypted_item(
        &self,
        vault_id: &str,
        item_id: &str,
        revision: i64,
        ciphertext: &[u8],
        wrapping_json: &str,
        ad_digest: &str,
    ) -> anyhow::Result<()> {
        let mut transaction = self.pool.begin().await?;
        sqlx::query(
            "INSERT INTO encrypted_item_revisions (id, vault_id, item_id, revision, envelope_version, ciphertext, wrapping_json, ad_digest, created_at) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?)",
        )
        .bind(uuid::Uuid::now_v7().to_string())
        .bind(vault_id)
        .bind(item_id)
        .bind(revision)
        .bind(ciphertext)
        .bind(wrapping_json)
        .bind(ad_digest)
        .bind(Utc::now().to_rfc3339())
        .execute(&mut *transaction)
        .await?;
        append_outbox_tx(
            &mut transaction,
            "vault.item_revision.written",
            &serde_json::json!({
                "vault_id": vault_id,
                "item_id": item_id,
                "revision": revision,
            })
            .to_string(),
        )
        .await?;
        transaction.commit().await?;
        Ok(())
    }

    /// Atomically write an owner-scoped encrypted sync blob and outbox event.
    ///
    /// # Errors
    ///
    /// Returns an error when the epoch exceeds `SQLite`'s range or a database
    /// transaction fails.
    pub async fn write_sync_blob(
        &self,
        owner_id: &str,
        blob: &StoredSyncBlob,
        store_limit: i64,
        owner_limit: i64,
    ) -> anyhow::Result<SyncWriteOutcome> {
        let outcomes = self
            .write_sync_blobs(
                owner_id,
                std::slice::from_ref(blob),
                store_limit,
                owner_limit,
            )
            .await?;
        outcomes
            .into_iter()
            .next()
            .context("single sync write produced no outcome")
    }

    /// Atomically write a related set of opaque sync blobs.
    ///
    /// If any member conflicts or exceeds quota, no member is written. This
    /// keeps a sealed vault header/body pair at one epoch and gives clients a
    /// reliable pull-merge-retry boundary.
    ///
    /// # Errors
    ///
    /// Returns an error when an epoch exceeds `SQLite`'s range or the database
    /// transaction fails.
    pub async fn write_sync_blobs(
        &self,
        owner_id: &str,
        blobs: &[StoredSyncBlob],
        store_limit: i64,
        owner_limit: i64,
    ) -> anyhow::Result<Vec<SyncWriteOutcome>> {
        if blobs.is_empty() {
            return Ok(Vec::new());
        }
        let epochs = blobs
            .iter()
            .map(|blob| i64::try_from(blob.epoch).context("sync epoch exceeds SQLite range"))
            .collect::<anyhow::Result<Vec<_>>>()?;
        let mut transaction = self.pool.begin().await?;
        let store_count: i64 = sqlx::query("SELECT COUNT(*) AS count FROM encrypted_sync_blobs")
            .fetch_one(&mut *transaction)
            .await?
            .get("count");
        let owner_count: i64 =
            sqlx::query("SELECT COUNT(*) AS count FROM encrypted_sync_blobs WHERE owner_id = ?")
                .bind(owner_id)
                .fetch_one(&mut *transaction)
                .await?
                .get("count");

        let mut outcomes = Vec::with_capacity(blobs.len());
        let mut existing = Vec::with_capacity(blobs.len());
        let mut new_count = 0i64;
        for (index, blob) in blobs.iter().enumerate() {
            // ponytail: batches are capped at 64 by the route; a linear scan is
            // smaller than another set allocation. Replace if that cap grows.
            if blobs[..index].iter().any(|prior| prior.id == blob.id) {
                outcomes.push(SyncWriteOutcome::BatchAborted);
                existing.push(false);
                continue;
            }
            let row = sqlx::query("SELECT owner_id, epoch FROM encrypted_sync_blobs WHERE id = ?")
                .bind(&blob.id)
                .fetch_optional(&mut *transaction)
                .await?;
            let outcome = match row {
                Some(ref row) if row.get::<String, _>("owner_id") != owner_id => {
                    SyncWriteOutcome::ForeignOwner
                }
                Some(ref row) if row.get::<i64, _>("epoch") >= epochs[index] => {
                    SyncWriteOutcome::StaleEpoch
                }
                Some(_) => SyncWriteOutcome::Accepted,
                None if store_count + new_count >= store_limit => SyncWriteOutcome::StoreFull,
                None if owner_count + new_count >= owner_limit => SyncWriteOutcome::OwnerQuota,
                None => {
                    new_count += 1;
                    SyncWriteOutcome::Accepted
                }
            };
            existing.push(row.is_some());
            outcomes.push(outcome);
        }

        if outcomes
            .iter()
            .any(|outcome| *outcome != SyncWriteOutcome::Accepted)
        {
            for outcome in outcomes
                .iter_mut()
                .filter(|outcome| **outcome == SyncWriteOutcome::Accepted)
            {
                *outcome = SyncWriteOutcome::BatchAborted;
            }
            return Ok(outcomes);
        }

        let updated_at = Utc::now().to_rfc3339();
        for ((blob, epoch), exists) in blobs.iter().zip(epochs).zip(existing) {
            if exists {
                sqlx::query(
                    "UPDATE encrypted_sync_blobs SET epoch = ?, ciphertext = ?, updated_at = ? WHERE id = ? AND owner_id = ?",
                )
                .bind(epoch)
                .bind(&blob.ciphertext)
                .bind(&updated_at)
                .bind(&blob.id)
                .bind(owner_id)
                .execute(&mut *transaction)
                .await?;
            } else {
                sqlx::query(
                    "INSERT INTO encrypted_sync_blobs (id, owner_id, epoch, ciphertext, updated_at) VALUES (?, ?, ?, ?, ?)",
                )
                .bind(&blob.id)
                .bind(owner_id)
                .bind(epoch)
                .bind(&blob.ciphertext)
                .bind(&updated_at)
                .execute(&mut *transaction)
                .await?;
            }
            append_sync_blob_outbox(&mut transaction, owner_id, &blob.id, epoch).await?;
        }
        transaction.commit().await?;
        Ok(outcomes)
    }

    /// List owner-scoped encrypted sync blobs newer than `since_epoch`.
    ///
    /// # Errors
    ///
    /// Returns an error when the query fails or a stored epoch is negative.
    pub async fn list_sync_blobs(
        &self,
        owner_id: &str,
        since_epoch: u64,
    ) -> anyhow::Result<Vec<StoredSyncBlob>> {
        let Ok(since_epoch) = i64::try_from(since_epoch) else {
            return Ok(vec![]);
        };
        let rows = sqlx::query(
            "SELECT id, epoch, ciphertext FROM encrypted_sync_blobs WHERE owner_id = ? AND epoch > ? ORDER BY epoch, id",
        )
        .bind(owner_id)
        .bind(since_epoch)
        .fetch_all(&self.pool)
        .await?;
        rows.into_iter()
            .map(|row| {
                Ok(StoredSyncBlob {
                    id: row.get("id"),
                    epoch: db_u64(row.get("epoch"), "sync epoch")?,
                    ciphertext: row.get("ciphertext"),
                })
            })
            .collect()
    }

    /// Count all encrypted sync blobs.
    ///
    /// # Errors
    ///
    /// Returns an error when the count query fails.
    pub async fn count_sync_blobs(&self) -> anyhow::Result<i64> {
        Ok(
            sqlx::query("SELECT COUNT(*) AS count FROM encrypted_sync_blobs")
                .fetch_one(&self.pool)
                .await?
                .get("count"),
        )
    }

    /// Advance an owner/device sync cursor without allowing it to move backward.
    ///
    /// # Errors
    ///
    /// Returns an error when the epoch exceeds `SQLite`'s range, database access
    /// fails, or a stored cursor is negative.
    pub async fn advance_sync_cursor(
        &self,
        owner_id: &str,
        device_id: &str,
        epoch: u64,
        max_cursors: i64,
    ) -> anyhow::Result<Option<u64>> {
        let epoch = i64::try_from(epoch).context("sync cursor exceeds SQLite range")?;
        let mut transaction = self.pool.begin().await?;
        let existing = sqlx::query(
            "SELECT epoch FROM sync_device_cursors WHERE owner_id = ? AND device_id = ?",
        )
        .bind(owner_id)
        .bind(device_id)
        .fetch_optional(&mut *transaction)
        .await?;
        if existing.is_none() {
            let count: i64 = sqlx::query("SELECT COUNT(*) AS count FROM sync_device_cursors")
                .fetch_one(&mut *transaction)
                .await?
                .get("count");
            if count >= max_cursors {
                return Ok(None);
            }
        }
        sqlx::query(
            "INSERT INTO sync_device_cursors (owner_id, device_id, epoch, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(owner_id, device_id) DO UPDATE SET epoch = MAX(epoch, excluded.epoch), updated_at = excluded.updated_at",
        )
        .bind(owner_id)
        .bind(device_id)
        .bind(epoch)
        .bind(Utc::now().to_rfc3339())
        .execute(&mut *transaction)
        .await?;
        let cursor = sqlx::query(
            "SELECT epoch FROM sync_device_cursors WHERE owner_id = ? AND device_id = ?",
        )
        .bind(owner_id)
        .bind(device_id)
        .fetch_one(&mut *transaction)
        .await?
        .get::<i64, _>("epoch");
        let cursor = db_u64(cursor, "sync cursor")?;
        transaction.commit().await?;
        Ok(Some(cursor))
    }

    // —— transactional outbox (ADR 0039) ————————————————————————

    /// Ciphertext rows a snapshot is built from. Only sealed bytes leave this
    /// query; there is no plaintext anywhere in the backup path.
    ///
    /// # Errors
    ///
    /// Returns an error when encrypted revisions cannot be queried.
    pub async fn list_encrypted_item_revisions(
        &self,
    ) -> anyhow::Result<Vec<EncryptedItemRevision>> {
        let rows = sqlx::query(
            "SELECT vault_id, item_id, revision, ciphertext, wrapping_json, ad_digest FROM encrypted_item_revisions ORDER BY vault_id, item_id, revision",
        )
        .fetch_all(&self.pool)
        .await?;
        Ok(rows
            .into_iter()
            .map(|row| EncryptedItemRevision {
                vault_id: row.get("vault_id"),
                item_id: row.get("item_id"),
                revision: row.get("revision"),
                ciphertext: row.get("ciphertext"),
                wrapping_json: row.get("wrapping_json"),
                ad_digest: row.get("ad_digest"),
            })
            .collect())
    }

    /// List every owner-scoped encrypted sync blob for snapshot backup.
    ///
    /// # Errors
    ///
    /// Returns an error when the query fails or a stored epoch is negative.
    pub async fn list_all_sync_blobs(&self) -> anyhow::Result<Vec<(String, StoredSyncBlob)>> {
        let rows = sqlx::query(
            "SELECT id, owner_id, epoch, ciphertext FROM encrypted_sync_blobs ORDER BY owner_id, epoch, id",
        )
        .fetch_all(&self.pool)
        .await?;
        rows.into_iter()
            .map(|row| {
                Ok((
                    row.get("owner_id"),
                    StoredSyncBlob {
                        id: row.get("id"),
                        epoch: db_u64(row.get("epoch"), "sync epoch")?,
                        ciphertext: row.get("ciphertext"),
                    },
                ))
            })
            .collect()
    }

    // —— certificate manager: shared helpers ——————————————————————
}
