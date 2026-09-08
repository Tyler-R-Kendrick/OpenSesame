//! Client-plane E2EE sync blobs, cursors and encrypted item revisions.
//!
//! Split out of the single `impl Db` block in `lib.rs`, which had grown to
//! 215 methods across 5,292 lines. Rust spreads a type's inherent impl over
//! any number of modules in the same crate, so this is a pure move: no
//! signature, visibility or call site changes.

use super::{
    append_outbox_tx, db_u64, Context, Db, EncryptedItemRevision, Row, StoredSyncBlob,
    SyncWriteOutcome, Utc,
};

#[path = "sync_pages.rs"]
mod pages;
#[path = "sync_rebind.rs"]
mod rebind;
#[path = "sync_write.rs"]
mod write;

/// Pagination sequence is independent from the ciphertext's original revision.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SyncPageEntry {
    pub sequence: u64,
    pub blob: StoredSyncBlob,
}

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
        self.write_sync_blobs_scoped(owner_id, "", blobs, store_limit, owner_limit)
            .await
    }

    /// Write ciphertext in one explicit organization, preserving owner isolation.
    ///
    /// # Errors
    /// Returns an error for invalid epochs, quota checks or database failure.
    pub async fn write_sync_blobs_scoped(
        &self,
        owner_id: &str,
        organization_id: &str,
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
            sqlx::query("SELECT COUNT(*) AS count FROM encrypted_sync_blobs WHERE owner_id = ? AND organization_id = ?")
                .bind(owner_id)
                .bind(organization_id)
                .fetch_one(&mut *transaction)
                .await?
                .get("count");

        let mut outcomes = Vec::with_capacity(blobs.len());
        let mut existing = Vec::with_capacity(blobs.len());
        let mut new_count = 0i64;
        let mut unchanged = 0usize;
        for (index, blob) in blobs.iter().enumerate() {
            // ponytail: batches are capped at 64 by the route; a linear scan is
            // smaller than another set allocation. Replace if that cap grows.
            if blobs[..index].iter().any(|prior| prior.id == blob.id) {
                outcomes.push(SyncWriteOutcome::BatchAborted);
                existing.push(false);
                continue;
            }
            let row = sqlx::query("SELECT owner_id, epoch, ciphertext = ? AS same_ciphertext FROM encrypted_sync_blobs WHERE id = ? AND organization_id = ?")
                .bind(&blob.ciphertext)
                .bind(&blob.id)
                .bind(organization_id)
                .fetch_optional(&mut *transaction)
                .await?;
            let outcome = match row {
                Some(ref row) if row.get::<String, _>("owner_id") != owner_id => {
                    SyncWriteOutcome::ForeignOwner
                }
                Some(ref row)
                    if row.get::<i64, _>("epoch") == epochs[index]
                        && row.get::<bool, _>("same_ciphertext") =>
                {
                    unchanged += 1;
                    SyncWriteOutcome::Accepted
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

        if unchanged == blobs.len() {
            return Ok(outcomes);
        }

        write::persist_batch(
            &mut transaction,
            owner_id,
            organization_id,
            blobs,
            &epochs,
            &existing,
        )
        .await?;
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
        anyhow::ensure!(
            since_epoch == 0,
            "legacy epoch cursors require migration to ingestion cursors"
        );
        let after = 0;
        let (blobs, more) = self
            .list_sync_blobs_page(owner_id, "", (after, ""), 64, true)
            .await?;
        anyhow::ensure!(!more, "legacy sync read requires pagination");
        Ok(blobs.into_iter().map(|entry| entry.blob).collect())
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
        self.list_encrypted_item_revisions_query(None).await
    }

    /// Read only revisions belonging to the selected backup organization.
    /// # Errors
    /// Returns database failures without changing stored ciphertext.
    pub async fn list_encrypted_item_revisions_scoped(
        &self,
        organization: &str,
    ) -> anyhow::Result<Vec<EncryptedItemRevision>> {
        self.list_encrypted_item_revisions_query(Some(organization))
            .await
    }

    async fn list_encrypted_item_revisions_query(
        &self,
        organization: Option<&str>,
    ) -> anyhow::Result<Vec<EncryptedItemRevision>> {
        let rows = sqlx::query(
            "SELECT r.vault_id, r.item_id, r.revision, r.ciphertext, r.wrapping_json, r.ad_digest FROM encrypted_item_revisions r JOIN vaults v ON v.id = r.vault_id WHERE (? IS NULL OR v.organization_id = ?) ORDER BY r.vault_id, r.item_id, r.revision",
        )
        .bind(organization).bind(organization)
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
}
