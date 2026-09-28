//! An account's name, address and existence, and the devices signed in to
//! it, behind the Bitwarden-compatible server (ADR 0148 §6).

use chrono::{DateTime, Utc};
use sqlx::Row as _;

use super::accounts::{bitwarden_timestamp, parse_bitwarden_timestamp};
use super::BitwardenCredentials;
use crate::Db;

/// A device as its account lists it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BitwardenDeviceSummary {
    pub id: String,
    pub identifier: String,
    pub name: String,
    pub device_type: i64,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

impl Db {
    /// Set the account's display name.
    ///
    /// # Errors
    ///
    /// Returns an error when the write fails.
    pub async fn bitwarden_set_name(
        &self,
        user_id: &str,
        name: Option<&str>,
    ) -> anyhow::Result<()> {
        let now = bitwarden_timestamp(Utc::now());
        sqlx::query(
            "UPDATE bitwarden_users SET name = ?, revision_at = ?, updated_at = ? WHERE id = ?",
        )
        .bind(name)
        .bind(&now)
        .bind(&now)
        .bind(user_id)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// Move the account to a new address with master-password material
    /// derived under it (the address is the KDF salt). Returns `false`, and
    /// changes nothing, when another account has the address.
    ///
    /// # Errors
    ///
    /// Returns an error when the transaction fails.
    pub async fn bitwarden_change_email(
        &self,
        user_id: &str,
        email: &str,
        credentials: &BitwardenCredentials,
    ) -> anyhow::Result<bool> {
        let now = bitwarden_timestamp(Utc::now());
        let mut tx = self.pool.begin().await?;
        let done = sqlx::query(
            "UPDATE bitwarden_users SET email = ?, master_password_hash = ?, kdf_type = ?, \
             kdf_iterations = ?, kdf_memory = ?, kdf_parallelism = ?, user_key = ?, \
             security_stamp = ?, revision_at = ?, updated_at = ? WHERE id = ? AND NOT EXISTS \
             (SELECT 1 FROM bitwarden_users WHERE email = ? AND id <> ?)",
        )
        .bind(email)
        .bind(&credentials.master_password_hash)
        .bind(credentials.kdf.kdf_type)
        .bind(credentials.kdf.iterations)
        .bind(credentials.kdf.memory)
        .bind(credentials.kdf.parallelism)
        .bind(&credentials.user_key)
        .bind(&credentials.security_stamp)
        .bind(&now)
        .bind(&now)
        .bind(user_id)
        .bind(email)
        .bind(user_id)
        .execute(&mut *tx)
        .await?;
        if done.rows_affected() != 1 {
            return Ok(false);
        }
        for statement in [
            "UPDATE bitwarden_org_members SET email = ? WHERE user_id = ?",
            "UPDATE bitwarden_emergency_access SET email = ? WHERE grantee_id = ?",
        ] {
            sqlx::query(statement)
                .bind(email)
                .bind(user_id)
                .execute(&mut *tx)
                .await?;
        }
        sqlx::query("UPDATE bitwarden_devices SET refresh_token_hash = NULL WHERE user_id = ?")
            .bind(user_id)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        Ok(true)
    }

    /// Delete the account and everything it owns.
    ///
    /// # Errors
    ///
    /// Returns an error when the write fails.
    pub async fn bitwarden_delete_user(&self, user_id: &str) -> anyhow::Result<bool> {
        let done = sqlx::query("DELETE FROM bitwarden_users WHERE id = ?")
            .bind(user_id)
            .execute(&self.pool)
            .await?;
        Ok(done.rows_affected() == 1)
    }

    /// The devices signed in to the account.
    ///
    /// # Errors
    ///
    /// Returns an error when the query fails or a row is malformed.
    pub async fn bitwarden_devices(
        &self,
        user_id: &str,
    ) -> anyhow::Result<Vec<BitwardenDeviceSummary>> {
        let rows = sqlx::query(
            "SELECT id, identifier, name, device_type, created_at, updated_at \
             FROM bitwarden_devices WHERE user_id = ? ORDER BY updated_at DESC",
        )
        .bind(user_id)
        .fetch_all(&self.pool)
        .await?;
        rows.iter()
            .map(|row| {
                Ok(BitwardenDeviceSummary {
                    id: row.get("id"),
                    identifier: row.get("identifier"),
                    name: row.get("name"),
                    device_type: row.get("device_type"),
                    created_at: parse_bitwarden_timestamp(&row.get::<String, _>("created_at"))?,
                    updated_at: parse_bitwarden_timestamp(&row.get::<String, _>("updated_at"))?,
                })
            })
            .collect()
    }

    /// Forget one of the account's devices; its refresh token dies with it.
    ///
    /// # Errors
    ///
    /// Returns an error when the write fails.
    pub async fn bitwarden_forget_device(&self, user_id: &str, id: &str) -> anyhow::Result<bool> {
        let done = sqlx::query("DELETE FROM bitwarden_devices WHERE user_id = ? AND id = ?")
            .bind(user_id)
            .bind(id)
            .execute(&self.pool)
            .await?;
        Ok(done.rows_affected() == 1)
    }
}
