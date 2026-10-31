//! Atomic per-profile, per-authoritative-source EST password reservations.
use crate::{Db, Row};

impl Db {
    /// Reserve one of five source-specific checks per profile in ten minutes.
    ///
    /// The caller derives `source_tag` from trusted transport evidence using
    /// its stable host key. Configuration updates and process restarts do not
    /// reset these reservations. Capacity is 1024 live sources per profile;
    /// existing sources retain their rows and only expired rows make room.
    ///
    /// # Errors
    /// Returns an error for a malformed tag, clock overflow or storage failure.
    pub async fn admit_est_passphrase_attempt(
        &self,
        organization_id: &str,
        config_id: &str,
        source_tag: &str,
        now: i64,
    ) -> anyhow::Result<Option<i64>> {
        anyhow::ensure!(
            source_tag.len() == 64 && source_tag.bytes().all(|byte| byte.is_ascii_hexdigit()),
            "invalid EST source tag"
        );
        let expiry = now
            .checked_add(600)
            .ok_or_else(|| anyhow::anyhow!("clock overflow"))?;
        let mut tx = self.pool().begin().await?;
        // Acquire SQLite's writer lock before checking capacity, including
        // across different processes. Never evict live sources to admit new ones.
        sqlx::query("DELETE FROM est_source_attempt_budgets WHERE organization_id = ? AND config_id = ? AND expires_at <= ?")
            .bind(organization_id).bind(config_id).bind(now).execute(&mut *tx).await?;
        let reserved = sqlx::query(
            "INSERT INTO est_source_attempt_budgets (organization_id, config_id, source_tag, expires_at, attempts)
             SELECT ?, ?, ?, ?, 1 FROM est_configs WHERE organization_id = ? AND id = ?
             AND (EXISTS (SELECT 1 FROM est_source_attempt_budgets WHERE organization_id = ? AND config_id = ? AND source_tag = ?)
                  OR (SELECT COUNT(*) FROM est_source_attempt_budgets WHERE organization_id = ? AND config_id = ?) < 1024)
             ON CONFLICT(organization_id, config_id, source_tag) DO UPDATE SET attempts = attempts + 1
             WHERE attempts < 5 RETURNING attempts",
        )
        .bind(organization_id).bind(config_id).bind(source_tag).bind(expiry)
        .bind(organization_id).bind(config_id)
        .bind(organization_id).bind(config_id).bind(source_tag)
        .bind(organization_id).bind(config_id)
        .fetch_optional(&mut *tx).await?;
        tx.commit().await?;
        reserved
            .map(|row| row.try_get("attempts").map_err(Into::into))
            .transpose()
    }
}
