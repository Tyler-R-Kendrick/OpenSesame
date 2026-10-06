//! Emergency access behind the Bitwarden-compatible server (ADR 0148 §6): a
//! trusted contact who may, after a waiting period the grantor can cut
//! short or refuse, view the grantor's vault or take the account over.
//!
//! `key_encrypted` is the grantor's user key wrapped under the contact's
//! public key by the grantor's device. The server stores and hands it over;
//! it cannot open it.

use chrono::{DateTime, Utc};
use sqlx::sqlite::SqliteRow;
use sqlx::Row as _;

use super::accounts::{bitwarden_timestamp, parse_bitwarden_timestamp};
use super::{member_type, BitwardenCredentials};
use crate::Db;

/// Emergency access statuses, as the wire enum carries them.
pub mod emergency_status {
    pub const INVITED: i64 = 0;
    pub const ACCEPTED: i64 = 1;
    pub const CONFIRMED: i64 = 2;
    pub const RECOVERY_INITIATED: i64 = 3;
    pub const RECOVERY_APPROVED: i64 = 4;
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BitwardenEmergencyAccess {
    pub id: String,
    pub grantor_id: String,
    pub grantee_id: Option<String>,
    /// The address invited, normalized.
    pub email: String,
    pub key_encrypted: Option<String>,
    /// 0 view, 1 takeover.
    pub access_type: i64,
    pub status: i64,
    pub wait_time_days: i64,
    pub recovery_initiated_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
    pub revision_at: DateTime<Utc>,
}

const COLUMNS: &str = "id, grantor_id, grantee_id, email, key_encrypted, access_type, status, \
     wait_time_days, recovery_initiated_at, created_at, revision_at";

fn access_from(row: &SqliteRow) -> anyhow::Result<BitwardenEmergencyAccess> {
    let initiated: Option<String> = row.get("recovery_initiated_at");
    Ok(BitwardenEmergencyAccess {
        id: row.get("id"),
        grantor_id: row.get("grantor_id"),
        grantee_id: row.get("grantee_id"),
        email: row.get("email"),
        key_encrypted: row.get("key_encrypted"),
        access_type: row.get("access_type"),
        status: row.get("status"),
        wait_time_days: row.get("wait_time_days"),
        recovery_initiated_at: initiated
            .as_deref()
            .map(parse_bitwarden_timestamp)
            .transpose()?,
        created_at: parse_bitwarden_timestamp(&row.get::<String, _>("created_at"))?,
        revision_at: parse_bitwarden_timestamp(&row.get::<String, _>("revision_at"))?,
    })
}

impl Db {
    /// Record an emergency contact. Returns `false`, and writes nothing, when
    /// the grantor already has one for that address.
    ///
    /// # Errors
    ///
    /// Returns an error when the write fails.
    pub async fn bitwarden_add_emergency_access(
        &self,
        access: &BitwardenEmergencyAccess,
    ) -> anyhow::Result<bool> {
        // Only compile-time column lists are interpolated; all caller values use bound parameters.
        // ast-grep-ignore: sql-format-injection
        let done = sqlx::query(&format!(
            "INSERT INTO bitwarden_emergency_access ({COLUMNS}) VALUES (?,?,?,?,?,?,?,?,?,?,?) \
             ON CONFLICT(grantor_id, email) DO NOTHING"
        ))
        .bind(&access.id)
        .bind(&access.grantor_id)
        .bind(&access.grantee_id)
        .bind(&access.email)
        .bind(&access.key_encrypted)
        .bind(access.access_type)
        .bind(access.status)
        .bind(access.wait_time_days)
        .bind(access.recovery_initiated_at.map(bitwarden_timestamp))
        .bind(bitwarden_timestamp(access.created_at))
        .bind(bitwarden_timestamp(access.revision_at))
        .execute(&self.pool)
        .await?;
        Ok(done.rows_affected() == 1)
    }

    /// One emergency access record.
    ///
    /// # Errors
    ///
    /// Returns an error when the query fails or the row is malformed.
    pub async fn bitwarden_emergency_access(
        &self,
        id: &str,
    ) -> anyhow::Result<Option<BitwardenEmergencyAccess>> {
        // Only compile-time column lists are interpolated; all caller values use bound parameters.
        // ast-grep-ignore: sql-format-injection
        let row = sqlx::query(&format!(
            "SELECT {COLUMNS} FROM bitwarden_emergency_access WHERE id = ?"
        ))
        .bind(id)
        .fetch_optional(&self.pool)
        .await?;
        row.as_ref().map(access_from).transpose()
    }

    /// The contacts an account has named (`as_grantor`), or the accounts that
    /// have named it (`!as_grantor`).
    ///
    /// # Errors
    ///
    /// Returns an error when the query fails or a row is malformed.
    pub async fn bitwarden_emergency_contacts(
        &self,
        user_id: &str,
        as_grantor: bool,
    ) -> anyhow::Result<Vec<BitwardenEmergencyAccess>> {
        let column = if as_grantor {
            "grantor_id"
        } else {
            "grantee_id"
        };
        // Only compile-time column lists are interpolated; all caller values use bound parameters.
        // ast-grep-ignore: sql-format-injection
        let rows = sqlx::query(&format!(
            "SELECT {COLUMNS} FROM bitwarden_emergency_access WHERE {column} = ? \
             ORDER BY created_at, id"
        ))
        .bind(user_id)
        .fetch_all(&self.pool)
        .await?;
        rows.iter().map(access_from).collect()
    }

    /// Move a record to `next`, only while it is still in `expected_status`.
    ///
    /// # Errors
    ///
    /// Returns an error when the write fails.
    pub async fn bitwarden_emergency_transition(
        &self,
        next: &BitwardenEmergencyAccess,
        expected_status: i64,
    ) -> anyhow::Result<bool> {
        let done = sqlx::query(
            "UPDATE bitwarden_emergency_access SET grantee_id = ?, key_encrypted = ?, \
             access_type = ?, status = ?, wait_time_days = ?, recovery_initiated_at = ?, \
             revision_at = ? WHERE id = ? AND status = ?",
        )
        .bind(&next.grantee_id)
        .bind(&next.key_encrypted)
        .bind(next.access_type)
        .bind(next.status)
        .bind(next.wait_time_days)
        .bind(next.recovery_initiated_at.map(bitwarden_timestamp))
        .bind(bitwarden_timestamp(next.revision_at))
        .bind(&next.id)
        .bind(expected_status)
        .execute(&self.pool)
        .await?;
        Ok(done.rows_affected() == 1)
    }

    /// Delete one record.
    ///
    /// # Errors
    ///
    /// Returns an error when the write fails.
    pub async fn bitwarden_delete_emergency_access(&self, id: &str) -> anyhow::Result<bool> {
        let done = sqlx::query("DELETE FROM bitwarden_emergency_access WHERE id = ?")
            .bind(id)
            .execute(&self.pool)
            .await?;
        Ok(done.rows_affected() == 1)
    }

    /// Invitations waiting for `email` become the new account's, accepted
    /// and awaiting the grantor's confirmation.
    ///
    /// # Errors
    ///
    /// Returns an error when the write fails.
    pub async fn bitwarden_claim_emergency_invitations(
        &self,
        user_id: &str,
        email: &str,
    ) -> anyhow::Result<u64> {
        let done = sqlx::query(
            "UPDATE bitwarden_emergency_access SET grantee_id = ?, status = ?, revision_at = ? \
             WHERE email = ? AND grantee_id IS NULL AND status = ? AND grantor_id <> ?",
        )
        .bind(user_id)
        .bind(emergency_status::ACCEPTED)
        .bind(bitwarden_timestamp(Utc::now()))
        .bind(email)
        .bind(emergency_status::INVITED)
        .bind(user_id)
        .execute(&self.pool)
        .await?;
        Ok(done.rows_affected())
    }

    /// An emergency contact takes the account over: new master-password
    /// material, every session, second step and personal API key gone, and
    /// every membership but ownership left, in one transaction.
    ///
    /// # Errors
    ///
    /// Returns an error when the transaction fails.
    pub async fn bitwarden_emergency_takeover(
        &self,
        grantor_id: &str,
        credentials: &BitwardenCredentials,
    ) -> anyhow::Result<()> {
        let now = bitwarden_timestamp(Utc::now());
        let mut tx = self.pool.begin().await?;
        sqlx::query(
            "UPDATE bitwarden_users SET master_password_hash = ?, kdf_type = ?, kdf_iterations = ?, \
             kdf_memory = ?, kdf_parallelism = ?, user_key = ?, user_key_id = NULL, \
             api_key = NULL, security_stamp = ?, revision_at = ?, updated_at = ? WHERE id = ?",
        )
        .bind(&credentials.master_password_hash)
        .bind(credentials.kdf.kdf_type)
        .bind(credentials.kdf.iterations)
        .bind(credentials.kdf.memory)
        .bind(credentials.kdf.parallelism)
        .bind(&credentials.user_key)
        .bind(&credentials.security_stamp)
        .bind(&now)
        .bind(&now)
        .bind(grantor_id)
        .execute(&mut *tx)
        .await?;
        for statement in [
            "UPDATE bitwarden_devices SET refresh_token_hash = NULL WHERE user_id = ?",
            "DELETE FROM bitwarden_two_factor WHERE user_id = ?",
        ] {
            sqlx::query(statement)
                .bind(grantor_id)
                .execute(&mut *tx)
                .await?;
        }
        sqlx::query("DELETE FROM bitwarden_org_members WHERE user_id = ? AND member_type <> ?")
            .bind(grantor_id)
            .bind(member_type::OWNER)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        Ok(())
    }
}
