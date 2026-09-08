//! Tenant-bound backup inventory: inspect bounded metadata before loading bodies.
use crate::{Db, EncryptedItemRevision};
use anyhow::Context;
use sqlx::Row;

const PAGE_ITEMS: usize = 32;
const PAGE_BYTES: usize = 8 * 1024 * 1024;
const ITEM_BYTES: usize = 2 * 1024 * 1024;
const TEXT_BYTES: usize = 16 * 1024;

pub struct BackupCredential {
    pub connection_id: String,
    pub version: String,
    pub ciphertext: Vec<u8>,
    pub nonce: Vec<u8>,
    pub aad_digest: String,
    pub token_type: String,
    pub expires_at: Option<String>,
    pub refreshable: bool,
}

fn reserve(row: &sqlx::sqlite::SqliteRow, remaining: &mut usize) -> anyhow::Result<bool> {
    let bytes = usize::try_from(row.try_get::<i64, _>("body_bytes")?)?;
    let text = usize::try_from(row.try_get::<i64, _>("text_bytes")?)?;
    anyhow::ensure!(
        bytes <= ITEM_BYTES && text <= TEXT_BYTES,
        "backup record exceeds portable policy"
    );
    // Base64 expansion plus worst-case JSON escaping and fixed framing.
    let cost = bytes
        .checked_add(2)
        .and_then(|n| (n / 3).checked_mul(4))
        .and_then(|n| n.checked_add(text.checked_mul(6)?))
        .and_then(|n| n.checked_add(2048))
        .context("backup size overflow")?;
    if cost > *remaining {
        return Ok(false);
    }
    *remaining -= cost;
    Ok(true)
}

impl Db {
    /// Read only a bounded page of the selected organization's sealed credentials.
    /// # Errors
    /// Refuses oversized metadata/body before loading it and propagates SQL errors.
    pub async fn backup_credentials_page(
        &self,
        organization: &str,
        after: &str,
    ) -> anyhow::Result<(Vec<BackupCredential>, bool)> {
        anyhow::ensure!(
            !organization.is_empty() && organization.len() <= 128 && after.len() <= 128,
            "invalid backup scope"
        );
        let mut tx = self.pool().begin().await?;
        let rows = sqlx::query(
            "SELECT CASE WHEN length(CAST(c.connection_id AS BLOB)) <= 128 THEN c.connection_id END AS id,
             length(c.ciphertext)+length(c.nonce) AS body_bytes,
             length(CAST(c.connection_id AS BLOB))+length(CAST(c.version AS BLOB))+
             length(CAST(c.aad_digest AS BLOB))+length(CAST(c.token_type AS BLOB))+
             COALESCE(length(CAST(c.expires_at AS BLOB)),0) AS text_bytes
             FROM connection_credentials c JOIN connections o ON o.id=c.connection_id
             WHERE o.organization_id=? AND c.connection_id>? ORDER BY c.connection_id LIMIT 33")
            .bind(organization).bind(after).fetch_all(&mut *tx).await?;
        let mut remaining = PAGE_BYTES;
        let mut page = Vec::new();
        for row in rows.iter().take(PAGE_ITEMS) {
            let id: String = row
                .try_get::<Option<String>, _>("id")?
                .context("oversized backup id")?;
            if !reserve(row, &mut remaining)? {
                break;
            }
            let body = sqlx::query("SELECT c.connection_id,c.version,c.ciphertext,c.nonce,c.aad_digest,c.token_type,c.expires_at,c.refreshable FROM connection_credentials c JOIN connections o ON o.id=c.connection_id WHERE o.organization_id=? AND c.connection_id=?")
                .bind(organization).bind(&id).fetch_one(&mut *tx).await?;
            page.push(BackupCredential {
                connection_id: id,
                version: body.try_get("version")?,
                ciphertext: body.try_get("ciphertext")?,
                nonce: body.try_get("nonce")?,
                aad_digest: body.try_get("aad_digest")?,
                token_type: body.try_get("token_type")?,
                expires_at: body.try_get("expires_at")?,
                refreshable: body.try_get::<i64, _>("refreshable")? != 0,
            });
        }
        tx.commit().await?;
        let more = page.len() < rows.len();
        Ok((page, more))
    }

    /// Read a bounded revision page with a stable complete composite key.
    /// # Errors
    /// Refuses oversized metadata/body before loading it and propagates SQL errors.
    pub async fn backup_revisions_page(
        &self,
        organization: &str,
        after: Option<&(String, String, i64)>,
    ) -> anyhow::Result<(Vec<EncryptedItemRevision>, bool)> {
        anyhow::ensure!(
            !organization.is_empty() && organization.len() <= 128,
            "invalid backup scope"
        );
        let (vault, item, revision) =
            after.map_or(("", "", i64::MIN), |(v, i, r)| (v.as_str(), i.as_str(), *r));
        anyhow::ensure!(
            vault.len() <= 128 && item.len() <= 128,
            "invalid backup cursor"
        );
        let mut tx = self.pool().begin().await?;
        let rows = sqlx::query(
            "SELECT CASE WHEN length(CAST(r.vault_id AS BLOB)) <= 128 THEN r.vault_id END AS vault,
             CASE WHEN length(CAST(r.item_id AS BLOB)) <= 128 THEN r.item_id END AS item,r.revision,
             length(r.ciphertext) AS body_bytes,
             length(CAST(r.vault_id AS BLOB))+length(CAST(r.item_id AS BLOB))+
             length(CAST(r.wrapping_json AS BLOB))+length(CAST(r.ad_digest AS BLOB)) AS text_bytes
             FROM encrypted_item_revisions r JOIN vaults v ON v.id=r.vault_id
             WHERE v.organization_id=? AND (r.vault_id,r.item_id,r.revision)>(?,?,?)
             ORDER BY r.vault_id,r.item_id,r.revision LIMIT 33",
        )
        .bind(organization)
        .bind(vault)
        .bind(item)
        .bind(revision)
        .fetch_all(&mut *tx)
        .await?;
        let mut remaining = PAGE_BYTES;
        let mut page = Vec::new();
        for row in rows.iter().take(PAGE_ITEMS) {
            let vault: String = row
                .try_get::<Option<String>, _>("vault")?
                .context("oversized vault id")?;
            let item: String = row
                .try_get::<Option<String>, _>("item")?
                .context("oversized item id")?;
            let revision: i64 = row.try_get("revision")?;
            anyhow::ensure!(revision >= 0, "invalid revision");
            if !reserve(row, &mut remaining)? {
                break;
            }
            let body = sqlx::query("SELECT r.ciphertext,r.wrapping_json,r.ad_digest FROM encrypted_item_revisions r JOIN vaults v ON v.id=r.vault_id WHERE v.organization_id=? AND r.vault_id=? AND r.item_id=? AND r.revision=?")
                .bind(organization).bind(&vault).bind(&item).bind(revision).fetch_one(&mut *tx).await?;
            page.push(EncryptedItemRevision {
                vault_id: vault,
                item_id: item,
                revision,
                ciphertext: body.try_get("ciphertext")?,
                wrapping_json: body.try_get("wrapping_json")?,
                ad_digest: body.try_get("ad_digest")?,
            });
        }
        tx.commit().await?;
        let more = page.len() < rows.len();
        Ok((page, more))
    }
}
