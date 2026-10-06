//! Attachments behind the Bitwarden-compatible server (ADR 0148): files on a
//! cipher, ciphertext its client encrypted under a key the server never
//! holds. Bytes sit in `bitwarden_blobs`, apart from the metadata, so a sync
//! never reads them; they are written once, in the transaction that marks the
//! upload done, and deleted by trigger with their owner.

use chrono::{DateTime, Utc};
use sqlx::sqlite::SqliteRow;
use sqlx::Row as _;

use super::accounts::{bitwarden_timestamp, parse_bitwarden_timestamp};
use crate::Db;

/// A file on a cipher. `file_name` and `key` are `EncString`s.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BitwardenAttachment {
    pub id: String,
    pub cipher_id: String,
    /// The account whose storage it counts against; `None` for a file on an
    /// organization's cipher.
    pub user_id: Option<String>,
    pub file_name: String,
    pub key: Option<String>,
    /// The size the client declared, in bytes; the upload must match it.
    pub size: i64,
    pub uploaded: bool,
    pub created_at: DateTime<Utc>,
}

fn attachment_from(row: &SqliteRow) -> anyhow::Result<BitwardenAttachment> {
    Ok(BitwardenAttachment {
        id: row.get("id"),
        cipher_id: row.get("cipher_id"),
        user_id: row.get("user_id"),
        file_name: row.get("file_name"),
        key: row.get("key"),
        size: row.get("size"),
        uploaded: row.get::<i64, _>("uploaded") != 0,
        created_at: parse_bitwarden_timestamp(&row.get::<String, _>("created_at"))?,
    })
}

const ATTACHMENT_COLUMNS: &str =
    "id, cipher_id, user_id, file_name, key, size, uploaded, created_at";

impl Db {
    /// Record an attachment the client is about to upload.
    ///
    /// # Errors
    ///
    /// Returns an error when the write fails.
    pub async fn bitwarden_add_attachment(
        &self,
        attachment: &BitwardenAttachment,
    ) -> anyhow::Result<()> {
        sqlx::query(
            "INSERT INTO bitwarden_attachments (id, cipher_id, user_id, file_name, key, size, \
             uploaded, created_at) VALUES (?,?,?,?,?,?,?,?)",
        )
        .bind(&attachment.id)
        .bind(&attachment.cipher_id)
        .bind(&attachment.user_id)
        .bind(&attachment.file_name)
        .bind(&attachment.key)
        .bind(attachment.size)
        .bind(i64::from(attachment.uploaded))
        .bind(bitwarden_timestamp(attachment.created_at))
        .execute(&self.pool)
        .await?;
        Ok(())
    }
    /// Every attachment on the account's ciphers.
    ///
    /// # Errors
    ///
    /// Returns an error when the query fails or a row is malformed.
    pub async fn bitwarden_attachments(
        &self,
        user_id: &str,
    ) -> anyhow::Result<Vec<BitwardenAttachment>> {
        // Only compile-time column lists are interpolated; all caller values use bound parameters.
        // ast-grep-ignore: sql-format-injection
        let rows = sqlx::query(&format!(
            "SELECT {ATTACHMENT_COLUMNS} FROM bitwarden_attachments WHERE user_id = ? \
             ORDER BY created_at, id"
        ))
        .bind(user_id)
        .fetch_all(&self.pool)
        .await?;
        rows.iter().map(attachment_from).collect()
    }
    /// Every attachment on an organization's ciphers.
    ///
    /// # Errors
    ///
    /// Returns an error when the query fails or a row is malformed.
    pub async fn bitwarden_org_attachments(
        &self,
        org_id: &str,
    ) -> anyhow::Result<Vec<BitwardenAttachment>> {
        // Only compile-time column lists are interpolated; all caller values use bound parameters.
        // ast-grep-ignore: sql-format-injection
        let rows = sqlx::query(&format!(
            "SELECT {ATTACHMENT_COLUMNS} FROM bitwarden_attachments WHERE cipher_id IN \
             (SELECT id FROM bitwarden_ciphers WHERE organization_id = ?) ORDER BY created_at, id"
        ))
        .bind(org_id)
        .fetch_all(&self.pool)
        .await?;
        rows.iter().map(attachment_from).collect()
    }

    /// One attachment of a cipher, whoever owns the cipher; the caller has
    /// already decided the account may reach it.
    ///
    /// # Errors
    ///
    /// Returns an error when the query fails or the row is malformed.
    pub async fn bitwarden_attachment_of(
        &self,
        cipher_id: &str,
        id: &str,
    ) -> anyhow::Result<Option<BitwardenAttachment>> {
        // Only compile-time column lists are interpolated; all caller values use bound parameters.
        // ast-grep-ignore: sql-format-injection
        let row = sqlx::query(&format!(
            "SELECT {ATTACHMENT_COLUMNS} FROM bitwarden_attachments WHERE cipher_id = ? AND id = ?"
        ))
        .bind(cipher_id)
        .bind(id)
        .fetch_optional(&self.pool)
        .await?;
        row.as_ref().map(attachment_from).transpose()
    }

    /// Store the bytes of an announced attachment of a cipher, once.
    ///
    /// # Errors
    ///
    /// Returns an error when the transaction fails.
    pub async fn bitwarden_upload_attachment_of(
        &self,
        cipher_id: &str,
        id: &str,
        bytes: &[u8],
    ) -> anyhow::Result<bool> {
        let mut tx = self.pool.begin().await?;
        let done = sqlx::query(
            "UPDATE bitwarden_attachments SET uploaded = 1 \
             WHERE id = ? AND cipher_id = ? AND uploaded = 0",
        )
        .bind(id)
        .bind(cipher_id)
        .execute(&mut *tx)
        .await?;
        if done.rows_affected() != 1 {
            return Ok(false);
        }
        sqlx::query("INSERT INTO bitwarden_blobs (id, data) VALUES (?, ?)")
            .bind(id)
            .bind(bytes)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        Ok(true)
    }

    /// Delete one attachment of a cipher the caller may change.
    ///
    /// # Errors
    ///
    /// Returns an error when the write fails.
    pub async fn bitwarden_delete_attachment_of(
        &self,
        cipher_id: &str,
        id: &str,
    ) -> anyhow::Result<bool> {
        let done = sqlx::query("DELETE FROM bitwarden_attachments WHERE cipher_id = ? AND id = ?")
            .bind(cipher_id)
            .bind(id)
            .execute(&self.pool)
            .await?;
        Ok(done.rows_affected() == 1)
    }

    /// Advance any cipher's revision date, as a change to its files does.
    ///
    /// # Errors
    ///
    /// Returns an error when the write fails.
    pub async fn bitwarden_touch_any_cipher(
        &self,
        cipher_id: &str,
        at: DateTime<Utc>,
    ) -> anyhow::Result<()> {
        sqlx::query("UPDATE bitwarden_ciphers SET revision_at = ? WHERE id = ?")
            .bind(bitwarden_timestamp(at))
            .bind(cipher_id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    /// Replace an attachment's key, name and bytes: the client re-encrypted
    /// it under an organization's key before sharing its cipher.
    ///
    /// # Errors
    ///
    /// Returns an error when the transaction fails.
    pub async fn bitwarden_rekey_attachment(
        &self,
        replacement: &BitwardenAttachment,
        bytes: &[u8],
    ) -> anyhow::Result<bool> {
        let mut tx = self.pool.begin().await?;
        let done = sqlx::query(
            "UPDATE bitwarden_attachments SET file_name = ?, key = ?, size = ?, uploaded = 1 \
             WHERE id = ? AND cipher_id = ?",
        )
        .bind(&replacement.file_name)
        .bind(&replacement.key)
        .bind(replacement.size)
        .bind(&replacement.id)
        .bind(&replacement.cipher_id)
        .execute(&mut *tx)
        .await?;
        if done.rows_affected() != 1 {
            return Ok(false);
        }
        sqlx::query("INSERT OR REPLACE INTO bitwarden_blobs (id, data) VALUES (?, ?)")
            .bind(&replacement.id)
            .bind(bytes)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        Ok(true)
    }

    /// Bytes an organization's cipher files take or have claimed.
    ///
    /// # Errors
    ///
    /// Returns an error when the query fails.
    pub async fn bitwarden_org_storage_used(&self, org_id: &str) -> anyhow::Result<i64> {
        Ok(sqlx::query_scalar(
            "SELECT COALESCE(SUM(size), 0) FROM bitwarden_attachments WHERE cipher_id IN \
             (SELECT id FROM bitwarden_ciphers WHERE organization_id = ?)",
        )
        .bind(org_id)
        .fetch_one(&self.pool)
        .await?)
    }

    /// Record an attachment with its bytes at once, as the importer does.
    /// Returns `false`, and writes nothing, when its id is taken.
    ///
    /// # Errors
    ///
    /// Returns an error when the transaction fails.
    pub async fn bitwarden_import_attachment(
        &self,
        attachment: &BitwardenAttachment,
        bytes: &[u8],
    ) -> anyhow::Result<bool> {
        let mut tx = self.pool.begin().await?;
        let done = sqlx::query(
            "INSERT INTO bitwarden_attachments (id, cipher_id, user_id, file_name, key, size, \
             uploaded, created_at) SELECT ?,?,?,?,?,?,1,? \
             WHERE NOT EXISTS (SELECT 1 FROM bitwarden_blobs WHERE id = ?) \
             ON CONFLICT(id) DO NOTHING",
        )
        .bind(&attachment.id)
        .bind(&attachment.cipher_id)
        .bind(&attachment.user_id)
        .bind(&attachment.file_name)
        .bind(&attachment.key)
        .bind(attachment.size)
        .bind(bitwarden_timestamp(attachment.created_at))
        .bind(&attachment.id)
        .execute(&mut *tx)
        .await?;
        if done.rows_affected() != 1 {
            return Ok(false);
        }
        sqlx::query("INSERT INTO bitwarden_blobs (id, data) VALUES (?, ?)")
            .bind(&attachment.id)
            .bind(bytes)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        Ok(true)
    }
    /// A file's bytes by blob id: an attachment's id or a Send's file id.
    ///
    /// # Errors
    ///
    /// Returns an error when the query fails.
    pub async fn bitwarden_blob(&self, id: &str) -> anyhow::Result<Option<Vec<u8>>> {
        Ok(
            sqlx::query_scalar("SELECT data FROM bitwarden_blobs WHERE id = ?")
                .bind(id)
                .fetch_optional(&self.pool)
                .await?,
        )
    }
}
