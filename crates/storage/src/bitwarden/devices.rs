//! Signed-in devices and the refresh tokens they hold (ADR 0141). A refresh
//! token is stored only as its SHA-256 digest, together with the security
//! stamp it was issued under and the moment it lapses.

use chrono::{DateTime, Utc};

use super::accounts::{bitwarden_timestamp, parse_bitwarden_timestamp};
use crate::{Db, Row};

/// A sign-in to record: which device, and the refresh token it now holds.
#[derive(Clone, Debug)]
pub struct BitwardenSignIn<'a> {
    pub user_id: &'a str,
    pub identifier: &'a str,
    pub name: &'a str,
    pub device_type: i64,
    pub refresh_token_hash: &'a str,
    /// The account's security stamp when the token was issued.
    pub security_stamp: &'a str,
    pub refresh_expires_at: DateTime<Utc>,
}

/// The device a refresh token was issued to.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BitwardenDevice {
    pub id: String,
    pub user_id: String,
    pub identifier: String,
    /// The account's security stamp when the refresh token was issued; a
    /// token from before a password or KDF change is refused on this alone.
    pub refresh_stamp: Option<String>,
    pub refresh_expires_at: Option<DateTime<Utc>>,
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
        sign_in: &BitwardenSignIn<'_>,
    ) -> anyhow::Result<String> {
        let now = bitwarden_timestamp(Utc::now());
        let row = sqlx::query(
            "INSERT INTO bitwarden_devices (id, user_id, identifier, name, device_type, \
             refresh_token_hash, refresh_stamp, refresh_expires_at, created_at, updated_at) \
             VALUES (?,?,?,?,?,?,?,?,?,?) \
             ON CONFLICT(user_id, identifier) DO UPDATE SET name = excluded.name, \
             device_type = excluded.device_type, refresh_token_hash = excluded.refresh_token_hash, \
             refresh_stamp = excluded.refresh_stamp, \
             refresh_expires_at = excluded.refresh_expires_at, \
             updated_at = excluded.updated_at RETURNING id",
        )
        .bind(uuid::Uuid::new_v4().to_string())
        .bind(sign_in.user_id)
        .bind(sign_in.identifier)
        .bind(sign_in.name)
        .bind(sign_in.device_type)
        .bind(sign_in.refresh_token_hash)
        .bind(sign_in.security_stamp)
        .bind(bitwarden_timestamp(sign_in.refresh_expires_at))
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
            "SELECT id, user_id, identifier, refresh_stamp, refresh_expires_at \
             FROM bitwarden_devices WHERE refresh_token_hash = ?",
        )
        .bind(refresh_token_hash)
        .fetch_optional(&self.pool)
        .await?;
        let Some(row) = row else {
            return Ok(None);
        };
        Ok(Some(BitwardenDevice {
            id: row.get("id"),
            user_id: row.get("user_id"),
            identifier: row.get("identifier"),
            refresh_stamp: row.get("refresh_stamp"),
            refresh_expires_at: row
                .get::<Option<String>, _>("refresh_expires_at")
                .as_deref()
                .map(parse_bitwarden_timestamp)
                .transpose()?,
        }))
    }

    /// Slide a device's refresh-token expiry forward after a successful use.
    ///
    /// # Errors
    ///
    /// Returns an error when the write fails.
    pub async fn bitwarden_extend_refresh(
        &self,
        device_id: &str,
        refresh_expires_at: DateTime<Utc>,
    ) -> anyhow::Result<()> {
        sqlx::query(
            "UPDATE bitwarden_devices SET refresh_expires_at = ?, updated_at = ? WHERE id = ?",
        )
        .bind(bitwarden_timestamp(refresh_expires_at))
        .bind(bitwarden_timestamp(Utc::now()))
        .bind(device_id)
        .execute(&self.pool)
        .await?;
        Ok(())
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
