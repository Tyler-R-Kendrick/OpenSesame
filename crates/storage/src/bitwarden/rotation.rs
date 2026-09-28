//! Rotating an account's user key (ADR 0148 §6), and the settings an
//! account keeps for itself.
//!
//! A rotation re-encrypts everything the old user key protected — personal
//! ciphers, folders, Sends, emergency contacts' keys, account-recovery keys —
//! and replaces the master-password material and the private key's wrap. It
//! lands in one transaction or not at all, and every row it names must be
//! the account's, so a half-rotated vault can never exist.

use chrono::{DateTime, Utc};
use sqlx::Row as _;

use super::accounts::bitwarden_timestamp;
use super::BitwardenCredentials;
use crate::Db;

/// One cipher's new contents.
#[derive(Clone, Debug)]
pub struct RotatedCipher {
    pub id: String,
    pub cipher_type: i64,
    pub data: String,
}

/// Everything one rotation writes.
#[derive(Clone, Debug)]
pub struct BitwardenKeyRotation {
    pub credentials: BitwardenCredentials,
    pub private_key: String,
    pub ciphers: Vec<RotatedCipher>,
    /// `(folder id, name)`.
    pub folders: Vec<(String, String)>,
    /// `(send id, key, data)`.
    pub sends: Vec<(String, String, String)>,
    /// `(emergency access id, key)`.
    pub emergency_keys: Vec<(String, String)>,
    /// `(organization id, account-recovery key)`.
    pub recovery_keys: Vec<(String, String)>,
    pub at: DateTime<Utc>,
}

/// What an account sets for itself.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct BitwardenAccountSettings {
    pub avatar_color: Option<String>,
    pub equivalent_domains: Option<String>,
    pub excluded_global_domains: Option<String>,
}

async fn exactly_one(
    tx: &mut sqlx::SqliteConnection,
    sql: &str,
    binds: &[&str],
) -> anyhow::Result<()> {
    let mut query = sqlx::query(sql);
    for value in binds {
        query = query.bind(*value);
    }
    let done = query.execute(&mut *tx).await?;
    anyhow::ensure!(
        done.rows_affected() == 1,
        "rotation names a row the account does not own"
    );
    Ok(())
}

impl Db {
    /// Apply a rotation for `user_id`, all of it or none.
    ///
    /// # Errors
    ///
    /// Returns an error, and changes nothing, when any row it names is not
    /// the account's or the transaction fails.
    pub async fn bitwarden_rotate_keys(
        &self,
        user_id: &str,
        rotation: &BitwardenKeyRotation,
    ) -> anyhow::Result<()> {
        let at = bitwarden_timestamp(rotation.at);
        let mut tx = self.pool.begin().await?;
        for cipher in &rotation.ciphers {
            let kind = cipher.cipher_type.to_string();
            exactly_one(
                &mut tx,
                "UPDATE bitwarden_ciphers SET cipher_type = ?, data = ?, revision_at = ? \
                 WHERE id = ? AND user_id = ?",
                &[&kind, &cipher.data, &at, &cipher.id, user_id],
            )
            .await?;
        }
        for (id, name) in &rotation.folders {
            exactly_one(
                &mut tx,
                "UPDATE bitwarden_folders SET name = ?, revision_at = ? WHERE id = ? AND user_id = ?",
                &[name, &at, id, user_id],
            )
            .await?;
        }
        for (id, key, data) in &rotation.sends {
            exactly_one(
                &mut tx,
                "UPDATE bitwarden_sends SET key = ?, data = ?, revision_at = ? \
                 WHERE id = ? AND user_id = ?",
                &[key, data, &at, id, user_id],
            )
            .await?;
        }
        for (id, key) in &rotation.emergency_keys {
            exactly_one(
                &mut tx,
                "UPDATE bitwarden_emergency_access SET key_encrypted = ?, revision_at = ? \
                 WHERE id = ? AND grantor_id = ?",
                &[key, &at, id, user_id],
            )
            .await?;
        }
        for (org, key) in &rotation.recovery_keys {
            exactly_one(
                &mut tx,
                "UPDATE bitwarden_org_members SET reset_password_key = ?, revision_at = ? \
                 WHERE org_id = ? AND user_id = ?",
                &[key, &at, org, user_id],
            )
            .await?;
        }
        let credentials = &rotation.credentials;
        sqlx::query(
            "UPDATE bitwarden_users SET master_password_hash = ?, user_key = ?, user_key_id = NULL, \
             private_key = ?, security_stamp = ?, revision_at = ?, updated_at = ? WHERE id = ?",
        )
        .bind(&credentials.master_password_hash)
        .bind(&credentials.user_key)
        .bind(&rotation.private_key)
        .bind(&credentials.security_stamp)
        .bind(&at)
        .bind(&at)
        .bind(user_id)
        .execute(&mut *tx)
        .await?;
        sqlx::query("UPDATE bitwarden_devices SET refresh_token_hash = NULL WHERE user_id = ?")
            .bind(user_id)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        Ok(())
    }

    /// The account's own settings.
    ///
    /// # Errors
    ///
    /// Returns an error when the query fails.
    pub async fn bitwarden_account_settings(
        &self,
        user_id: &str,
    ) -> anyhow::Result<BitwardenAccountSettings> {
        let row = sqlx::query(
            "SELECT avatar_color, equivalent_domains, excluded_global_domains \
             FROM bitwarden_account_settings WHERE user_id = ?",
        )
        .bind(user_id)
        .fetch_optional(&self.pool)
        .await?;
        Ok(row.map_or_else(BitwardenAccountSettings::default, |row| {
            BitwardenAccountSettings {
                avatar_color: row.get("avatar_color"),
                equivalent_domains: row.get("equivalent_domains"),
                excluded_global_domains: row.get("excluded_global_domains"),
            }
        }))
    }

    /// Replace the account's own settings.
    ///
    /// # Errors
    ///
    /// Returns an error when the write fails.
    pub async fn bitwarden_put_account_settings(
        &self,
        user_id: &str,
        settings: &BitwardenAccountSettings,
    ) -> anyhow::Result<()> {
        sqlx::query(
            "INSERT INTO bitwarden_account_settings (user_id, avatar_color, equivalent_domains, \
             excluded_global_domains) VALUES (?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET \
             avatar_color = excluded.avatar_color, equivalent_domains = excluded.equivalent_domains, \
             excluded_global_domains = excluded.excluded_global_domains",
        )
        .bind(user_id)
        .bind(&settings.avatar_color)
        .bind(&settings.equivalent_domains)
        .bind(&settings.excluded_global_domains)
        .execute(&self.pool)
        .await?;
        Ok(())
    }
}
