//! Signed-in devices and the refresh tokens they hold (ADR 0140). A refresh
//! token is stored only as its SHA-256 digest.

use chrono::Utc;

use super::accounts::bitwarden_timestamp;
use crate::{Db, Row};

/// The device a refresh token was issued to.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BitwardenDevice {
    pub id: String,
    pub user_id: String,
    pub identifier: String,
}

impl Db {
    /// Record a signed-in device and the hash of the refresh token it holds.
    /// Returns the device's server id.
    ///
    /// # Errors
    ///
    /// Returns an error when the write fails.
    pub async fn bitwarden_upsert_device(
        &self,
        user_id: &str,
        identifier: &str,
        name: &str,
        device_type: i64,
        refresh_token_hash: &str,
    ) -> anyhow::Result<String> {
        let now = bitwarden_timestamp(Utc::now());
        let row = sqlx::query(
            "INSERT INTO bitwarden_devices (id, user_id, identifier, name, device_type, \
             refresh_token_hash, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?) \
             ON CONFLICT(user_id, identifier) DO UPDATE SET name = excluded.name, \
             device_type = excluded.device_type, refresh_token_hash = excluded.refresh_token_hash, \
             updated_at = excluded.updated_at RETURNING id",
        )
        .bind(uuid::Uuid::new_v4().to_string())
        .bind(user_id)
        .bind(identifier)
        .bind(name)
        .bind(device_type)
        .bind(refresh_token_hash)
        .bind(&now)
        .bind(&now)
        .fetch_one(&self.pool)
        .await?;
        Ok(row.get("id"))
    }

    /// Resolve a refresh token hash to the device holding it.
    ///
    /// # Errors
    ///
    /// Returns an error when the query fails.
    pub async fn bitwarden_device_by_refresh(
        &self,
        refresh_token_hash: &str,
    ) -> anyhow::Result<Option<BitwardenDevice>> {
        let row = sqlx::query(
            "SELECT id, user_id, identifier FROM bitwarden_devices WHERE refresh_token_hash = ?",
        )
        .bind(refresh_token_hash)
        .fetch_optional(&self.pool)
        .await?;
        Ok(row.map(|row| BitwardenDevice {
            id: row.get("id"),
            user_id: row.get("user_id"),
            identifier: row.get("identifier"),
        }))
    }

    /// Whether this account has signed in from a device with this identifier.
    ///
    /// # Errors
    ///
    /// Returns an error when the query fails.
    pub async fn bitwarden_device_known(
        &self,
        email: &str,
        identifier: &str,
    ) -> anyhow::Result<bool> {
        let row = sqlx::query(
            "SELECT 1 AS known FROM bitwarden_devices d JOIN bitwarden_users u ON u.id = d.user_id \
             WHERE u.email = ? AND d.identifier = ?",
        )
        .bind(email)
        .bind(identifier)
        .fetch_optional(&self.pool)
        .await?;
        Ok(row.is_some())
    }
}
