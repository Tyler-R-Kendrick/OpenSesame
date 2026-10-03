//! Sign-in methods beside the master password (ADR 0148): the personal API
//! key, two-step providers with their replay guard, the recovery code, and
//! "remember this device".
//!
//! None of these opens a vault. They decide whether a sign-in may proceed;
//! the vault still needs the master password on the device.

use chrono::{DateTime, Utc};
use sqlx::Row as _;

use super::accounts::{bitwarden_timestamp, parse_bitwarden_timestamp};
use crate::Db;

/// One two-step provider an account has set up. `data` is what the server
/// checks a code against (an authenticator's base32 key).
#[derive(Clone, PartialEq, Eq)]
pub struct BitwardenTwoFactor {
    pub provider: i64,
    pub enabled: bool,
    pub data: String,
    /// The last time step a code was accepted for; a code for this step or an
    /// earlier one is never accepted again.
    pub last_used_step: i64,
}

/// A remembered device's token, as a digest, and the stamp it belongs to.
#[derive(Clone, Debug)]
pub struct BitwardenRemember<'a> {
    pub user_id: &'a str,
    pub identifier: &'a str,
    pub token_hash: &'a str,
    pub security_stamp: &'a str,
    pub expires_at: DateTime<Utc>,
}

impl Db {
    /// Every two-step provider the account has, enabled or pending.
    ///
    /// # Errors
    ///
    /// Returns an error when the query fails.
    pub async fn bitwarden_two_factors(
        &self,
        user_id: &str,
    ) -> anyhow::Result<Vec<BitwardenTwoFactor>> {
        let rows = sqlx::query(
            "SELECT provider, enabled, data, last_used_step FROM bitwarden_two_factor \
             WHERE user_id = ? ORDER BY provider",
        )
        .bind(user_id)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows
            .iter()
            .map(|row| BitwardenTwoFactor {
                provider: row.get("provider"),
                enabled: row.get::<i64, _>("enabled") != 0,
                data: row.get("data"),
                last_used_step: row.get("last_used_step"),
            })
            .collect())
    }

    /// Set up or replace one provider. The replay guard starts at `used_step`.
    ///
    /// # Errors
    ///
    /// Returns an error when the write fails.
    pub async fn bitwarden_put_two_factor(
        &self,
        user_id: &str,
        factor: &BitwardenTwoFactor,
    ) -> anyhow::Result<()> {
        let now = bitwarden_timestamp(Utc::now());
        sqlx::query(
            "INSERT INTO bitwarden_two_factor (user_id, provider, enabled, data, last_used_step, \
             created_at, updated_at) VALUES (?,?,?,?,?,?,?) \
             ON CONFLICT(user_id, provider) DO UPDATE SET enabled = excluded.enabled, \
             data = excluded.data, last_used_step = excluded.last_used_step, \
             updated_at = excluded.updated_at",
        )
        .bind(user_id)
        .bind(factor.provider)
        .bind(i64::from(factor.enabled))
        .bind(&factor.data)
        .bind(factor.last_used_step)
        .bind(&now)
        .bind(&now)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// Remove one provider (`Some`) or all of them (`None`). Returns how many
    /// went. Removing every provider also forgets every remembered device.
    ///
    /// # Errors
    ///
    /// Returns an error when the write fails.
    pub async fn bitwarden_delete_two_factors(
        &self,
        user_id: &str,
        provider: Option<i64>,
    ) -> anyhow::Result<u64> {
        let mut tx = self.pool.begin().await?;
        let done = sqlx::query(
            "DELETE FROM bitwarden_two_factor WHERE user_id = ? AND (? IS NULL OR provider = ?)",
        )
        .bind(user_id)
        .bind(provider)
        .bind(provider)
        .execute(&mut *tx)
        .await?;
        let left: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM bitwarden_two_factor WHERE user_id = ? AND enabled = 1",
        )
        .bind(user_id)
        .fetch_one(&mut *tx)
        .await?;
        if left == 0 {
            sqlx::query(
                "UPDATE bitwarden_devices SET remember_hash = NULL, remember_stamp = NULL, \
                 remember_expires_at = NULL WHERE user_id = ?",
            )
            .bind(user_id)
            .execute(&mut *tx)
            .await?;
        }
        tx.commit().await?;
        Ok(done.rows_affected())
    }

    /// Spend a time step: `true` only when `step` is later than every step
    /// accepted before, so a code is good once.
    ///
    /// # Errors
    ///
    /// Returns an error when the write fails.
    pub async fn bitwarden_spend_step(
        &self,
        user_id: &str,
        provider: i64,
        step: i64,
    ) -> anyhow::Result<bool> {
        let done = sqlx::query(
            "UPDATE bitwarden_two_factor SET last_used_step = ?, updated_at = ? \
             WHERE user_id = ? AND provider = ? AND enabled = 1 AND last_used_step < ?",
        )
        .bind(step)
        .bind(bitwarden_timestamp(Utc::now()))
        .bind(user_id)
        .bind(provider)
        .bind(step)
        .execute(&self.pool)
        .await?;
        Ok(done.rows_affected() == 1)
    }

    /// The account's personal API key, if it has one.
    ///
    /// # Errors
    ///
    /// Returns an error when the query fails.
    pub async fn bitwarden_api_key(&self, user_id: &str) -> anyhow::Result<Option<String>> {
        Ok(
            sqlx::query_scalar("SELECT api_key FROM bitwarden_users WHERE id = ?")
                .bind(user_id)
                .fetch_optional(&self.pool)
                .await?
                .flatten(),
        )
    }

    /// Set the personal API key.
    ///
    /// # Errors
    ///
    /// Returns an error when the write fails.
    pub async fn bitwarden_set_api_key(&self, user_id: &str, key: &str) -> anyhow::Result<()> {
        sqlx::query("UPDATE bitwarden_users SET api_key = ? WHERE id = ?")
            .bind(key)
            .bind(user_id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    /// The account's two-step recovery code, if it has one.
    ///
    /// # Errors
    ///
    /// Returns an error when the query fails.
    pub async fn bitwarden_recovery_code(&self, user_id: &str) -> anyhow::Result<Option<String>> {
        Ok(
            sqlx::query_scalar("SELECT recovery_code FROM bitwarden_users WHERE id = ?")
                .bind(user_id)
                .fetch_optional(&self.pool)
                .await?
                .flatten(),
        )
    }

    /// Replace the recovery code only while it is still `expected`: a code is
    /// spent once, even by two requests at the same moment.
    ///
    /// # Errors
    ///
    /// Returns an error when the write fails.
    pub async fn bitwarden_replace_recovery_code(
        &self,
        user_id: &str,
        expected: Option<&str>,
        code: &str,
    ) -> anyhow::Result<bool> {
        let done = sqlx::query(
            "UPDATE bitwarden_users SET recovery_code = ? WHERE id = ? AND recovery_code IS ?",
        )
        .bind(code)
        .bind(user_id)
        .bind(expected)
        .execute(&self.pool)
        .await?;
        Ok(done.rows_affected() == 1)
    }

    /// Remember a device for two-step login.
    ///
    /// # Errors
    ///
    /// Returns an error when the write fails.
    pub async fn bitwarden_remember_device(
        &self,
        remember: &BitwardenRemember<'_>,
    ) -> anyhow::Result<()> {
        sqlx::query(
            "UPDATE bitwarden_devices SET remember_hash = ?, remember_stamp = ?, \
             remember_expires_at = ? WHERE user_id = ? AND identifier = ?",
        )
        .bind(remember.token_hash)
        .bind(remember.security_stamp)
        .bind(bitwarden_timestamp(remember.expires_at))
        .bind(remember.user_id)
        .bind(remember.identifier)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// Whether this device holds a live remember token for the account under
    /// its current security stamp.
    ///
    /// # Errors
    ///
    /// Returns an error when the query fails.
    pub async fn bitwarden_remembered(
        &self,
        remember: &BitwardenRemember<'_>,
    ) -> anyhow::Result<bool> {
        let row = sqlx::query(
            "SELECT remember_expires_at FROM bitwarden_devices WHERE user_id = ? \
             AND identifier = ? AND remember_hash = ? AND remember_stamp = ?",
        )
        .bind(remember.user_id)
        .bind(remember.identifier)
        .bind(remember.token_hash)
        .bind(remember.security_stamp)
        .fetch_optional(&self.pool)
        .await?;
        let Some(row) = row else {
            return Ok(false);
        };
        let expires = row
            .get::<Option<String>, _>("remember_expires_at")
            .as_deref()
            .map(parse_bitwarden_timestamp)
            .transpose()?;
        Ok(expires.is_some_and(|at| at > Utc::now()))
    }
}
