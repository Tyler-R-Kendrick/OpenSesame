//! Durable, bounded admission before credential verification.
//!
//! Reservations happen atomically before a password or code is examined. Live
//! buckets are never evicted: capacity exhaustion refuses new attempts rather
//! than reopening an account's budget. A successful proof clears its bucket.

use std::time::Duration;

use opensesame_storage::Db;
use sha2::{Digest, Sha256};

const CAPACITY: i64 = 10_000;

pub struct FailureLimiter {
    db: Db,
    namespace: &'static str,
    max_attempts: u32,
    window: Duration,
}

impl FailureLimiter {
    #[must_use]
    pub fn new(db: Db, namespace: &'static str, max_attempts: u32, window: Duration) -> Self {
        Self {
            db,
            namespace,
            max_attempts: max_attempts.max(1),
            window,
        }
    }

    fn bucket(key: &str) -> String {
        hex::encode(Sha256::digest(key.as_bytes()))
    }

    /// Reserve one check before examining any secret. Storage failures must
    /// propagate to the caller; they never grant an uncounted check.
    ///
    /// # Errors
    /// Returns a storage or clock-overflow error.
    pub async fn reserve(&self, key: &str) -> anyhow::Result<bool> {
        self.reserve_at(key, chrono::Utc::now().timestamp_millis())
            .await
    }

    async fn reserve_at(&self, key: &str, now: i64) -> anyhow::Result<bool> {
        let duration = i64::try_from(self.window.as_millis())?;
        let expiry = now
            .checked_add(duration)
            .ok_or_else(|| anyhow::anyhow!("clock overflow"))?;
        let bucket = Self::bucket(key);
        let mut tx = self.db.pool().begin().await?;
        // Taking the write lock before checking capacity serializes separate
        // Host instances too. Only expired rows can ever make room.
        sqlx::query(
            "DELETE FROM bitwarden_attempt_budgets WHERE namespace = ? AND expires_at <= ?",
        )
        .bind(self.namespace)
        .bind(now)
        .execute(&mut *tx)
        .await?;
        let reserved = sqlx::query(
            "INSERT INTO bitwarden_attempt_budgets (namespace, bucket, expires_at, attempts)
             SELECT ?, ?, ?, 1 WHERE
             EXISTS (SELECT 1 FROM bitwarden_attempt_budgets WHERE namespace = ? AND bucket = ?)
             OR (SELECT COUNT(*) FROM bitwarden_attempt_budgets WHERE namespace = ?) < ?
             ON CONFLICT(namespace, bucket) DO UPDATE SET attempts = attempts + 1
             WHERE attempts < ? RETURNING attempts",
        )
        .bind(self.namespace)
        .bind(&bucket)
        .bind(expiry)
        .bind(self.namespace)
        .bind(&bucket)
        .bind(self.namespace)
        .bind(CAPACITY)
        .bind(i64::from(self.max_attempts))
        .fetch_optional(&mut *tx)
        .await?
        .is_some();
        tx.commit().await?;
        Ok(reserved)
    }

    /// # Errors
    /// Returns an error when the successful proof's budget cannot be cleared.
    pub async fn clear(&self, key: &str) -> anyhow::Result<()> {
        sqlx::query("DELETE FROM bitwarden_attempt_budgets WHERE namespace = ? AND bucket = ?")
            .bind(self.namespace)
            .bind(Self::bucket(key))
            .execute(self.db.pool())
            .await?;
        Ok(())
    }
}

#[cfg(test)]
#[path = "limiter_tests.rs"]
mod tests;
