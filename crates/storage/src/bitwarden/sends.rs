//! Sends behind the Bitwarden-compatible server (ADR 0148): text or a file
//! shared by link, encrypted under a key that travels only in the link. A
//! file's bytes sit in `bitwarden_blobs` and go with the Send.

use chrono::{DateTime, Utc};
use sqlx::sqlite::SqliteRow;
use sqlx::Row as _;

use super::accounts::{bitwarden_timestamp, parse_bitwarden_timestamp};
use crate::Db;

/// A Send: text or a file shared by link. `data` is the client's encrypted
/// payload as JSON (name, notes, and the text or file name).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BitwardenSend {
    pub id: String,
    pub user_id: String,
    pub send_type: i64,
    pub data: String,
    pub key: String,
    /// A registry hash of the client's password hash, when the Send has one.
    pub password_hash: Option<String>,
    pub max_access_count: Option<i64>,
    pub access_count: i64,
    pub disabled: bool,
    pub hide_email: bool,
    pub file_id: Option<String>,
    pub file_size: Option<i64>,
    pub uploaded: bool,
    pub created_at: DateTime<Utc>,
    pub revision_at: DateTime<Utc>,
    pub expiration_at: Option<DateTime<Utc>>,
    pub deletion_at: DateTime<Utc>,
}

fn optional_time(row: &SqliteRow, column: &str) -> anyhow::Result<Option<DateTime<Utc>>> {
    row.get::<Option<String>, _>(column)
        .as_deref()
        .map(parse_bitwarden_timestamp)
        .transpose()
}

fn send_from(row: &SqliteRow) -> anyhow::Result<BitwardenSend> {
    Ok(BitwardenSend {
        id: row.get("id"),
        user_id: row.get("user_id"),
        send_type: row.get("send_type"),
        data: row.get("data"),
        key: row.get("key"),
        password_hash: row.get("password_hash"),
        max_access_count: row.get("max_access_count"),
        access_count: row.get("access_count"),
        disabled: row.get::<i64, _>("disabled") != 0,
        hide_email: row.get::<i64, _>("hide_email") != 0,
        file_id: row.get("file_id"),
        file_size: row.get("file_size"),
        uploaded: row.get::<i64, _>("uploaded") != 0,
        created_at: parse_bitwarden_timestamp(&row.get::<String, _>("created_at"))?,
        revision_at: parse_bitwarden_timestamp(&row.get::<String, _>("revision_at"))?,
        expiration_at: optional_time(row, "expiration_at")?,
        deletion_at: parse_bitwarden_timestamp(&row.get::<String, _>("deletion_at"))?,
    })
}

const SEND_COLUMNS: &str = "id, user_id, send_type, data, key, password_hash, max_access_count, \
     access_count, disabled, hide_email, file_id, file_size, uploaded, created_at, revision_at, \
     expiration_at, deletion_at";

impl Db {
    /// Record a Send, with its file's bytes if it has one, as the importer
    /// does. Returns `false`, and writes nothing, when an id is taken.
    ///
    /// # Errors
    ///
    /// Returns an error when the transaction fails.
    pub async fn bitwarden_import_send(
        &self,
        send: &BitwardenSend,
        bytes: Option<&[u8]>,
    ) -> anyhow::Result<bool> {
        let mut tx = self.pool.begin().await?;
        let taken: Option<(String,)> = sqlx::query_as(
            "SELECT id FROM bitwarden_sends WHERE id = ? \
             UNION SELECT id FROM bitwarden_blobs WHERE id = ?",
        )
        .bind(&send.id)
        .bind(send.file_id.as_deref().unwrap_or(""))
        .fetch_optional(&mut *tx)
        .await?;
        if taken.is_some() {
            return Ok(false);
        }
        sqlx::query(&format!(
            "INSERT INTO bitwarden_sends ({SEND_COLUMNS}) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)"
        ))
        .bind(&send.id)
        .bind(&send.user_id)
        .bind(send.send_type)
        .bind(&send.data)
        .bind(&send.key)
        .bind(&send.password_hash)
        .bind(send.max_access_count)
        .bind(send.access_count)
        .bind(i64::from(send.disabled))
        .bind(i64::from(send.hide_email))
        .bind(&send.file_id)
        .bind(send.file_size)
        .bind(i64::from(send.uploaded))
        .bind(bitwarden_timestamp(send.created_at))
        .bind(bitwarden_timestamp(send.revision_at))
        .bind(send.expiration_at.map(bitwarden_timestamp))
        .bind(bitwarden_timestamp(send.deletion_at))
        .execute(&mut *tx)
        .await?;
        if let (Some(file_id), Some(bytes)) = (&send.file_id, bytes) {
            sqlx::query("INSERT INTO bitwarden_blobs (id, data) VALUES (?, ?)")
                .bind(file_id)
                .bind(bytes)
                .execute(&mut *tx)
                .await?;
        }
        tx.commit().await?;
        Ok(true)
    }
    /// Bytes the account's files take or have claimed: attachments and Send
    /// files, uploaded or announced.
    ///
    /// # Errors
    ///
    /// Returns an error when the query fails.
    pub async fn bitwarden_storage_used(&self, user_id: &str) -> anyhow::Result<i64> {
        Ok(sqlx::query_scalar(
            "SELECT COALESCE((SELECT SUM(size) FROM bitwarden_attachments WHERE user_id = ?), 0) \
             + COALESCE((SELECT SUM(file_size) FROM bitwarden_sends WHERE user_id = ?), 0)",
        )
        .bind(user_id)
        .bind(user_id)
        .fetch_one(&self.pool)
        .await?)
    }
    /// Create or replace a Send the account owns.
    ///
    /// # Errors
    ///
    /// Returns an error when the write fails.
    pub async fn bitwarden_put_send(&self, send: &BitwardenSend) -> anyhow::Result<()> {
        sqlx::query(&format!(
            "INSERT INTO bitwarden_sends ({SEND_COLUMNS}) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) \
             ON CONFLICT(id) DO UPDATE SET data = excluded.data, key = excluded.key, \
             password_hash = excluded.password_hash, max_access_count = excluded.max_access_count, \
             disabled = excluded.disabled, hide_email = excluded.hide_email, \
             revision_at = excluded.revision_at, expiration_at = excluded.expiration_at, \
             deletion_at = excluded.deletion_at WHERE bitwarden_sends.user_id = excluded.user_id"
        ))
        .bind(&send.id)
        .bind(&send.user_id)
        .bind(send.send_type)
        .bind(&send.data)
        .bind(&send.key)
        .bind(&send.password_hash)
        .bind(send.max_access_count)
        .bind(send.access_count)
        .bind(i64::from(send.disabled))
        .bind(i64::from(send.hide_email))
        .bind(&send.file_id)
        .bind(send.file_size)
        .bind(i64::from(send.uploaded))
        .bind(bitwarden_timestamp(send.created_at))
        .bind(bitwarden_timestamp(send.revision_at))
        .bind(send.expiration_at.map(bitwarden_timestamp))
        .bind(bitwarden_timestamp(send.deletion_at))
        .execute(&self.pool)
        .await?;
        Ok(())
    }
    /// The account's Sends, past their deletion date or not.
    ///
    /// # Errors
    ///
    /// Returns an error when the query fails or a row is malformed.
    pub async fn bitwarden_sends(&self, user_id: &str) -> anyhow::Result<Vec<BitwardenSend>> {
        let rows = sqlx::query(&format!(
            "SELECT {SEND_COLUMNS} FROM bitwarden_sends WHERE user_id = ? ORDER BY created_at, id"
        ))
        .bind(user_id)
        .fetch_all(&self.pool)
        .await?;
        rows.iter().map(send_from).collect()
    }
    /// One Send by id, whoever owns it (the public access routes use this).
    ///
    /// # Errors
    ///
    /// Returns an error when the query fails or the row is malformed.
    pub async fn bitwarden_send(&self, id: &str) -> anyhow::Result<Option<BitwardenSend>> {
        let row = sqlx::query(&format!(
            "SELECT {SEND_COLUMNS} FROM bitwarden_sends WHERE id = ?"
        ))
        .bind(id)
        .fetch_optional(&self.pool)
        .await?;
        row.as_ref().map(send_from).transpose()
    }
    /// Count one access, only while the count is still `seen` and below the
    /// Send's limit: two readers can never both take the last access.
    ///
    /// # Errors
    ///
    /// Returns an error when the write fails.
    pub async fn bitwarden_count_send_access(&self, id: &str, seen: i64) -> anyhow::Result<bool> {
        let done = sqlx::query(
            "UPDATE bitwarden_sends SET access_count = access_count + 1 WHERE id = ? \
             AND access_count = ? AND (max_access_count IS NULL OR access_count < max_access_count)",
        )
        .bind(id)
        .bind(seen)
        .execute(&self.pool)
        .await?;
        Ok(done.rows_affected() == 1)
    }
    /// Store a file Send's bytes, once.
    ///
    /// # Errors
    ///
    /// Returns an error when the transaction fails.
    pub async fn bitwarden_upload_send_file(
        &self,
        user_id: &str,
        id: &str,
        file_id: &str,
        bytes: &[u8],
    ) -> anyhow::Result<bool> {
        let mut tx = self.pool.begin().await?;
        let done = sqlx::query(
            "UPDATE bitwarden_sends SET uploaded = 1 \
             WHERE id = ? AND user_id = ? AND file_id = ? AND uploaded = 0",
        )
        .bind(id)
        .bind(user_id)
        .bind(file_id)
        .execute(&mut *tx)
        .await?;
        if done.rows_affected() != 1 {
            return Ok(false);
        }
        sqlx::query("INSERT INTO bitwarden_blobs (id, data) VALUES (?, ?)")
            .bind(file_id)
            .bind(bytes)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        Ok(true)
    }
    /// Delete a Send the account owns, with its file.
    ///
    /// # Errors
    ///
    /// Returns an error when the write fails.
    pub async fn bitwarden_delete_send(&self, user_id: &str, id: &str) -> anyhow::Result<bool> {
        let done = sqlx::query("DELETE FROM bitwarden_sends WHERE user_id = ? AND id = ?")
            .bind(user_id)
            .bind(id)
            .execute(&self.pool)
            .await?;
        Ok(done.rows_affected() == 1)
    }
    /// Delete every Send whose deletion date has passed. Returns how many.
    ///
    /// # Errors
    ///
    /// Returns an error when the write fails.
    pub async fn bitwarden_purge_sends(&self, now: DateTime<Utc>) -> anyhow::Result<u64> {
        let done = sqlx::query("DELETE FROM bitwarden_sends WHERE deletion_at <= ?")
            .bind(bitwarden_timestamp(now))
            .execute(&self.pool)
            .await?;
        Ok(done.rows_affected())
    }
}
