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
    pub user_id: String,
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
        let rows = sqlx::query(&format!(
            "SELECT {ATTACHMENT_COLUMNS} FROM bitwarden_attachments WHERE user_id = ? \
             ORDER BY created_at, id"
        ))
        .bind(user_id)
        .fetch_all(&self.pool)
        .await?;
        rows.iter().map(attachment_from).collect()
    }
    /// One attachment of one of the account's ciphers.
    ///
    /// # Errors
    ///
    /// Returns an error when the query fails or the row is malformed.
    pub async fn bitwarden_attachment(
        &self,
        user_id: &str,
        cipher_id: &str,
        id: &str,
    ) -> anyhow::Result<Option<BitwardenAttachment>> {
        let row = sqlx::query(&format!(
            "SELECT {ATTACHMENT_COLUMNS} FROM bitwarden_attachments \
             WHERE user_id = ? AND cipher_id = ? AND id = ?"
        ))
        .bind(user_id)
        .bind(cipher_id)
        .bind(id)
        .fetch_optional(&self.pool)
        .await?;
        row.as_ref().map(attachment_from).transpose()
    }
    /// Store an upload's bytes and mark it done, once. Returns `false`, and
    /// writes nothing, when the attachment is unknown or already uploaded.
    ///
    /// # Errors
    ///
    /// Returns an error when the transaction fails.
    pub async fn bitwarden_upload_attachment(
        &self,
        user_id: &str,
        id: &str,
        bytes: &[u8],
    ) -> anyhow::Result<bool> {
        let mut tx = self.pool.begin().await?;
        let done = sqlx::query(
            "UPDATE bitwarden_attachments SET uploaded = 1 \
             WHERE id = ? AND user_id = ? AND uploaded = 0",
        )
        .bind(id)
        .bind(user_id)
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
    /// Delete one attachment and its bytes.
    ///
    /// # Errors
    ///
    /// Returns an error when the write fails.
    pub async fn bitwarden_delete_attachment(
        &self,
        user_id: &str,
        cipher_id: &str,
        id: &str,
    ) -> anyhow::Result<bool> {
        let done = sqlx::query(
            "DELETE FROM bitwarden_attachments WHERE user_id = ? AND cipher_id = ? AND id = ?",
        )
        .bind(user_id)
        .bind(cipher_id)
        .bind(id)
        .execute(&self.pool)
        .await?;
        Ok(done.rows_affected() == 1)
    }
    /// Advance a cipher's revision date, as a change to its files does.
    ///
    /// # Errors
    ///
    /// Returns an error when the write fails.
    pub async fn bitwarden_touch_cipher(
        &self,
        user_id: &str,
        cipher_id: &str,
        at: DateTime<Utc>,
    ) -> anyhow::Result<()> {
        sqlx::query("UPDATE bitwarden_ciphers SET revision_at = ? WHERE id = ? AND user_id = ?")
            .bind(bitwarden_timestamp(at))
            .bind(cipher_id)
            .bind(user_id)
            .execute(&self.pool)
            .await?;
        Ok(())
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
