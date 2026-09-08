//! Allocation-bounded ciphertext keyset reads.
use super::SyncPageEntry;
use crate::{db_u64, Db, StoredSyncBlob};
use anyhow::Context;
use sqlx::Row;

impl Db {
    /// Read a bounded operator-backup page across organizations, including quarantine.
    ///
    /// # Errors
    /// Rejects oversized/corrupt stored metadata or database failures.
    pub async fn list_sync_backup_page(
        &self,
        after: Option<&(String, String, u64, String)>,
    ) -> anyhow::Result<(Vec<(String, String, SyncPageEntry)>, bool)> {
        self.sync_backup_page_query(None, after).await
    }

    /// Read a tenant's backup page. Quarantined legacy rows are not tenant data.
    /// # Errors
    /// Rejects missing tenant scope and corrupt or oversized stored records.
    pub async fn list_sync_backup_page_scoped(
        &self,
        organization: &str,
        after: Option<&(String, String, u64, String)>,
    ) -> anyhow::Result<(Vec<(String, String, SyncPageEntry)>, bool)> {
        anyhow::ensure!(!organization.is_empty(), "backup organization required");
        self.sync_backup_page_query(Some(organization), after).await
    }

    async fn sync_backup_page_query(
        &self,
        organization: Option<&str>,
        after: Option<&(String, String, u64, String)>,
    ) -> anyhow::Result<(Vec<(String, String, SyncPageEntry)>, bool)> {
        let (org, owner, epoch, id) = after.map_or(("", "", i64::MIN, ""), |cursor| {
            (
                cursor.0.as_str(),
                cursor.1.as_str(),
                i64::try_from(cursor.2).unwrap_or(i64::MAX),
                cursor.3.as_str(),
            )
        });
        let mut transaction = self.pool.begin().await?;
        let rows = sqlx::query("SELECT CASE WHEN length(CAST(organization_id AS BLOB)) <= 128 THEN organization_id END AS organization_id, CASE WHEN length(CAST(owner_id AS BLOB)) <= 128 THEN owner_id END AS owner_id, CASE WHEN length(CAST(id AS BLOB)) <= 128 THEN id END AS id, epoch, ingestion_epoch, length(ciphertext) AS bytes FROM encrypted_sync_blobs WHERE (? IS NULL OR organization_id = ?) AND (ingestion_epoch, organization_id, owner_id, id) > (?, ?, ?, ?) ORDER BY ingestion_epoch, organization_id, owner_id, id LIMIT 33")
            .bind(organization).bind(organization).bind(epoch).bind(org).bind(owner).bind(id).fetch_all(&mut *transaction).await?;
        let mut budget = 8 * 1024 * 1024usize - 1024;
        let mut blobs = Vec::new();
        for row in rows.iter().take(32) {
            let org = row
                .get::<Option<String>, _>("organization_id")
                .context("oversized organization id")?;
            let owner = row
                .get::<Option<String>, _>("owner_id")
                .context("oversized owner id")?;
            let id = row
                .get::<Option<String>, _>("id")
                .context("oversized blob id")?;
            let bytes = usize::try_from(row.get::<i64, _>("bytes"))?;
            let cost = bytes
                .checked_add(2)
                .and_then(|size| (size / 3).checked_mul(4))
                .and_then(|size| size.checked_add(256 + 6 * (org.len() + owner.len() + id.len())))
                .context("sync size overflow")?;
            if cost > budget {
                anyhow::ensure!(!blobs.is_empty(), "sync blob exceeds backup page budget");
                break;
            }
            budget -= cost;
            let ciphertext = sqlx::query_scalar("SELECT ciphertext FROM encrypted_sync_blobs WHERE organization_id = ? AND owner_id = ? AND id = ?")
                .bind(&org).bind(&owner).bind(&id).fetch_one(&mut *transaction).await?;
            blobs.push((
                org,
                owner,
                SyncPageEntry {
                    sequence: db_u64(row.get("ingestion_epoch"), "sync ingestion epoch")?,
                    blob: StoredSyncBlob {
                        id,
                        epoch: db_u64(row.get("epoch"), "sync epoch")?,
                        ciphertext,
                    },
                },
            ));
        }
        transaction.commit().await?;
        let more = blobs.len() < rows.len();
        Ok((blobs, more))
    }

    /// Read one keyset page, bounding ciphertext allocation before loading bodies.
    /// An empty `after_id` includes the given epoch; a nonempty id continues it.
    ///
    /// # Errors
    /// Returns an error for invalid cursors, oversized legacy records or database failure.
    pub async fn list_sync_blobs_page(
        &self,
        owner_id: &str,
        organization_id: &str,
        after: (u64, &str),
        limit: u32,
        legacy: bool,
    ) -> anyhow::Result<(Vec<SyncPageEntry>, bool)> {
        let (after_epoch, after_id) = after;
        anyhow::ensure!(
            (1..=64).contains(&limit) && after_id.len() <= 128,
            "invalid sync cursor"
        );
        let epoch = i64::try_from(after_epoch).context("invalid sync epoch")?;
        // Metadata is bounded before it crosses SQLite's boundary. Existing
        // corrupt/oversized ids fail explicitly, never silently skip a row.
        let mut transaction = self.pool.begin().await?;
        let rows = sqlx::query(
            "SELECT CASE WHEN length(CAST(id AS BLOB)) <= 128 THEN id END AS id, epoch, ingestion_epoch, length(ciphertext) AS bytes FROM encrypted_sync_blobs WHERE owner_id = ? AND organization_id = ? AND (ingestion_epoch > ? OR (ingestion_epoch = ? AND id > ?)) ORDER BY ingestion_epoch, id LIMIT ?",
        )
        .bind(owner_id).bind(organization_id).bind(epoch).bind(epoch).bind(after_id)
        .bind(i64::from(limit) + 1)
        .fetch_all(&mut *transaction).await?;
        let mut budget = 8 * 1024 * 1024usize - 1024;
        let mut blobs = Vec::new();
        let total = rows.len();
        for row in rows.iter().take(limit as usize) {
            let id: Option<String> = row.get("id");
            let id = id.context("sync blob id exceeds portable policy")?;
            let bytes = usize::try_from(row.get::<i64, _>("bytes"))?;
            let payload = if legacy {
                bytes.checked_mul(4)
            } else {
                bytes.checked_add(2).and_then(|n| (n / 3).checked_mul(4))
            }
            .context("sync size overflow")?;
            let cost = payload
                .checked_add(id.len() * 6 + 256)
                .context("sync size overflow")?;
            if cost > budget {
                anyhow::ensure!(
                    !blobs.is_empty(),
                    "sync blob exceeds page policy; use v2 or offline migration"
                );
                break;
            }
            budget -= cost;
            let body = sqlx::query("SELECT ciphertext FROM encrypted_sync_blobs WHERE owner_id = ? AND organization_id = ? AND id = ?")
                .bind(owner_id).bind(organization_id).bind(&id).fetch_one(&mut *transaction).await?;
            blobs.push(SyncPageEntry {
                sequence: db_u64(row.get("ingestion_epoch"), "sync ingestion epoch")?,
                blob: StoredSyncBlob {
                    id,
                    epoch: db_u64(row.get("epoch"), "sync epoch")?,
                    ciphertext: body.get("ciphertext"),
                },
            });
        }
        transaction.commit().await?;
        let has_more = blobs.len() < total;
        Ok((blobs, has_more))
    }
}
