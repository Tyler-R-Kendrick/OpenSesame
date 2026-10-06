//! "Log in with device" behind the Bitwarden-compatible server (ADR 0148
//! §8): a new device's request, and the answer one of the account's own
//! devices gives it. The access code is held only as a digest; the answer
//! is the user key wrapped under the asking device's public key.

use chrono::{DateTime, Utc};
use sqlx::sqlite::SqliteRow;
use sqlx::Row as _;

use super::accounts::{bitwarden_timestamp, parse_bitwarden_timestamp};
use crate::Db;

#[derive(Clone, PartialEq, Eq)]
pub struct BitwardenAuthRequest {
    pub id: String,
    pub user_id: String,
    pub device_identifier: String,
    pub device_type: i64,
    /// Hex SHA-256 of the access code the asking device holds.
    pub access_code_digest: String,
    pub public_key: String,
    /// The user key under `public_key`, once approved.
    pub key: Option<String>,
    pub master_password_hash: Option<String>,
    /// `None` while pending; approvals only — a denial deletes the request.
    pub approved: Option<bool>,
    pub response_device: Option<String>,
    pub created_at: DateTime<Utc>,
    pub response_at: Option<DateTime<Utc>>,
}

const COLUMNS: &str = "id, user_id, device_identifier, device_type, access_code_digest, \
     public_key, key, master_password_hash, approved, response_device, created_at, response_at";

fn request_from(row: &SqliteRow) -> anyhow::Result<BitwardenAuthRequest> {
    let response: Option<String> = row.get("response_at");
    Ok(BitwardenAuthRequest {
        id: row.get("id"),
        user_id: row.get("user_id"),
        device_identifier: row.get("device_identifier"),
        device_type: row.get("device_type"),
        access_code_digest: row.get("access_code_digest"),
        public_key: row.get("public_key"),
        key: row.get("key"),
        master_password_hash: row.get("master_password_hash"),
        approved: row.get::<Option<i64>, _>("approved").map(|a| a != 0),
        response_device: row.get("response_device"),
        created_at: parse_bitwarden_timestamp(&row.get::<String, _>("created_at"))?,
        response_at: response
            .as_deref()
            .map(parse_bitwarden_timestamp)
            .transpose()?,
    })
}

impl Db {
    /// Record a request, unless the account already has `max_pending`
    /// unanswered ones newer than `since`; older ones are dropped first.
    ///
    /// # Errors
    ///
    /// Returns an error when the transaction fails.
    pub async fn bitwarden_add_auth_request(
        &self,
        request: &BitwardenAuthRequest,
        since: DateTime<Utc>,
        max_pending: i64,
    ) -> anyhow::Result<bool> {
        let mut tx = self.pool.begin().await?;
        sqlx::query("DELETE FROM bitwarden_auth_requests WHERE created_at < ?")
            .bind(bitwarden_timestamp(since))
            .execute(&mut *tx)
            .await?;
        let pending: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM bitwarden_auth_requests WHERE user_id = ? AND approved IS NULL",
        )
        .bind(&request.user_id)
        .fetch_one(&mut *tx)
        .await?;
        if pending >= max_pending {
            return Ok(false);
        }
        // Only compile-time column lists are interpolated; all caller values use bound parameters.
        // ast-grep-ignore: sql-format-injection
        sqlx::query(&format!(
            "INSERT INTO bitwarden_auth_requests ({COLUMNS}) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)"
        ))
        .bind(&request.id)
        .bind(&request.user_id)
        .bind(&request.device_identifier)
        .bind(request.device_type)
        .bind(&request.access_code_digest)
        .bind(&request.public_key)
        .bind(&request.key)
        .bind(&request.master_password_hash)
        .bind(request.approved.map(i64::from))
        .bind(&request.response_device)
        .bind(bitwarden_timestamp(request.created_at))
        .bind(request.response_at.map(bitwarden_timestamp))
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        Ok(true)
    }

    /// One request, if it was made after `since`.
    ///
    /// # Errors
    ///
    /// Returns an error when the query fails or the row is malformed.
    pub async fn bitwarden_auth_request(
        &self,
        id: &str,
        since: DateTime<Utc>,
    ) -> anyhow::Result<Option<BitwardenAuthRequest>> {
        // Only compile-time column lists are interpolated; all caller values use bound parameters.
        // ast-grep-ignore: sql-format-injection
        let row = sqlx::query(&format!(
            "SELECT {COLUMNS} FROM bitwarden_auth_requests WHERE id = ? AND created_at >= ?"
        ))
        .bind(id)
        .bind(bitwarden_timestamp(since))
        .fetch_optional(&self.pool)
        .await?;
        row.as_ref().map(request_from).transpose()
    }

    /// The account's requests made after `since`.
    ///
    /// # Errors
    ///
    /// Returns an error when the query fails or a row is malformed.
    pub async fn bitwarden_auth_requests(
        &self,
        user_id: &str,
        since: DateTime<Utc>,
    ) -> anyhow::Result<Vec<BitwardenAuthRequest>> {
        // Only compile-time column lists are interpolated; all caller values use bound parameters.
        // ast-grep-ignore: sql-format-injection
        let rows = sqlx::query(&format!(
            "SELECT {COLUMNS} FROM bitwarden_auth_requests WHERE user_id = ? AND created_at >= ? \
             ORDER BY created_at"
        ))
        .bind(user_id)
        .bind(bitwarden_timestamp(since))
        .fetch_all(&self.pool)
        .await?;
        rows.iter().map(request_from).collect()
    }

    /// Approve a pending request of the account, once.
    ///
    /// # Errors
    ///
    /// Returns an error when the write fails.
    pub async fn bitwarden_approve_auth_request(
        &self,
        user_id: &str,
        id: &str,
        key: &str,
        master_password_hash: Option<&str>,
        response_device: &str,
    ) -> anyhow::Result<bool> {
        let done = sqlx::query(
            "UPDATE bitwarden_auth_requests SET approved = 1, key = ?, master_password_hash = ?, \
             response_device = ?, response_at = ? WHERE id = ? AND user_id = ? AND approved IS NULL",
        )
        .bind(key)
        .bind(master_password_hash)
        .bind(response_device)
        .bind(bitwarden_timestamp(Utc::now()))
        .bind(id)
        .bind(user_id)
        .execute(&self.pool)
        .await?;
        Ok(done.rows_affected() == 1)
    }

    /// Delete a request: denied, or spent by the sign-in it allowed. Returns
    /// whether it was there to delete, so it is spent exactly once.
    ///
    /// # Errors
    ///
    /// Returns an error when the write fails.
    pub async fn bitwarden_delete_auth_request(
        &self,
        user_id: &str,
        id: &str,
    ) -> anyhow::Result<bool> {
        let done = sqlx::query("DELETE FROM bitwarden_auth_requests WHERE id = ? AND user_id = ?")
            .bind(id)
            .bind(user_id)
            .execute(&self.pool)
            .await?;
        Ok(done.rows_affected() == 1)
    }
}
