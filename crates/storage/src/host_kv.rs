//! The host key/value table used for small singleton host state.
//!
//! Split out of the single `impl Db` block in `lib.rs`, which had grown to
//! 215 methods across 5,292 lines. Rust spreads a type's inherent impl over
//! any number of modules in the same crate, so this is a pure move: no
//! signature, visibility or call site changes.

use super::{Db, Row, Utc};

impl Db {
    /// Read a host-operator key/value entry.
    ///
    /// # Errors
    ///
    /// Returns an error when the query fails.
    pub async fn get_host_kv(&self, key: &str) -> anyhow::Result<Option<String>> {
        let row = sqlx::query("SELECT value FROM host_kv WHERE key = ?")
            .bind(key)
            .fetch_optional(&self.pool)
            .await?;
        Ok(row.map(|r| r.get::<String, _>("value")))
    }

    /// Insert or replace a host-operator key/value entry.
    ///
    /// # Errors
    ///
    /// Returns an error when the database write fails.
    pub async fn set_host_kv(&self, key: &str, value: &str) -> anyhow::Result<()> {
        sqlx::query(
            "INSERT INTO host_kv (key, value, updated_at) VALUES (?, ?, ?) \
             ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
        )
        .bind(key)
        .bind(value)
        .bind(Utc::now().to_rfc3339())
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// Insert `key` only when absent. Returns `true` when this call claimed the key.
    ///
    /// # Errors
    ///
    /// Returns an error when the database write fails.
    pub async fn try_claim_host_kv(&self, key: &str, value: &str) -> anyhow::Result<bool> {
        let result = sqlx::query(
            "INSERT INTO host_kv (key, value, updated_at) VALUES (?, ?, ?) \
             ON CONFLICT(key) DO NOTHING",
        )
        .bind(key)
        .bind(value)
        .bind(Utc::now().to_rfc3339())
        .execute(&self.pool)
        .await?;
        Ok(result.rows_affected() > 0)
    }

    /// Delete a host-operator key/value entry.
    ///
    /// # Errors
    ///
    /// Returns an error when the database deletion fails.
    pub async fn delete_host_kv(&self, key: &str) -> anyhow::Result<()> {
        sqlx::query("DELETE FROM host_kv WHERE key = ?")
            .bind(key)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    // —— backup targets (ADR 0039) ——————————————————————————————
}
