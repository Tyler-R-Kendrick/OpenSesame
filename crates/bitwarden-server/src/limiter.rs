//! Durable, bounded admission before credential verification.
//!
//! Reservations happen atomically before a password or code is examined. Live
//! buckets are never evicted. Subjects come from loaded credential objects;
//! invented IDs allocate nothing, and one object's guesses cannot exhaust a
//! global bucket capacity. A successful proof clears only its own bucket.

use std::time::Duration;

use opensesame_storage::Db;
use sha2::{Digest, Sha256};

use crate::budget_subject::BudgetSubject;

pub(crate) struct FailureLimiter {
    db: Db,
    namespace: &'static str,
    max_attempts: u32,
    window: Duration,
}

impl FailureLimiter {
    #[must_use]
    pub(crate) fn new(
        db: Db,
        namespace: &'static str,
        max_attempts: u32,
        window: Duration,
    ) -> Self {
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
    pub(crate) async fn reserve(&self, subject: &BudgetSubject<'_>) -> anyhow::Result<bool> {
        self.reserve_at(subject, chrono::Utc::now().timestamp_millis())
            .await
    }

    async fn reserve_at(&self, subject: &BudgetSubject<'_>, now: i64) -> anyhow::Result<bool> {
        let duration = i64::try_from(self.window.as_millis())?;
        let expiry = now
            .checked_add(duration)
            .ok_or_else(|| anyhow::anyhow!("clock overflow"))?;
        let bucket = Self::bucket(&subject.key());
        let mut tx = self.db.pool().begin().await?;
        // Taking the write lock serializes separate Host instances too.
        // Only expired rows are collected; a live lockout is never displaced.
        sqlx::query(
            "DELETE FROM bitwarden_attempt_budgets WHERE namespace = ? AND expires_at <= ?",
        )
        .bind(self.namespace)
        .bind(now)
        .execute(&mut *tx)
        .await?;
        let reserved = sqlx::query(
            "INSERT INTO bitwarden_attempt_budgets (namespace, bucket, expires_at, attempts)
             VALUES (?, ?, ?, 1)
             ON CONFLICT(namespace, bucket) DO UPDATE SET attempts = attempts + 1
             WHERE attempts < ? RETURNING attempts",
        )
        .bind(self.namespace)
        .bind(&bucket)
        .bind(expiry)
        .bind(i64::from(self.max_attempts))
        .fetch_optional(&mut *tx)
        .await?
        .is_some();
        tx.commit().await?;
        Ok(reserved)
    }

    /// # Errors
    /// Returns an error when the successful proof's budget cannot be cleared.
    pub(crate) async fn clear(&self, subject: &BudgetSubject<'_>) -> anyhow::Result<()> {
        sqlx::query("DELETE FROM bitwarden_attempt_budgets WHERE namespace = ? AND bucket = ?")
            .bind(self.namespace)
            .bind(Self::bucket(&subject.key()))
            .execute(self.db.pool())
            .await?;
        Ok(())
    }
}

#[cfg(test)]
#[path = "limiter_tests.rs"]
mod tests;
