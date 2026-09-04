//! The transactional outbox: append, claim, publish, park, dead-letter.
//!
//! Split out of the single `impl Db` block in `lib.rs`, which had grown to
//! 215 methods across 5,292 lines. Rust spreads a type's inherent impl over
//! any number of modules in the same crate, so this is a pure move: no
//! signature, visibility or call site changes.

use super::{append_outbox_tx, Db, OutboxEvent, Row, Utc};

impl Db {
    /// Broadcast a change event in its own transaction. Mutations that already
    /// hold a transaction use [`append_outbox_tx`] instead, so the event and
    /// the change it describes commit or roll back together.
    ///
    /// # Errors
    ///
    /// Returns an error when the outbox row or transaction cannot be committed.
    pub async fn append_outbox(
        &self,
        event_type: &str,
        payload_json: &str,
    ) -> anyhow::Result<String> {
        let mut transaction = self.pool.begin().await?;
        let id = append_outbox_tx(&mut transaction, event_type, payload_json).await?;
        transaction.commit().await?;
        Ok(id)
    }

    /// Claim due unpublished events for one worker pass. Claimed rows have
    /// their `available_at` pushed `lease_seconds` into the future, so a
    /// crashed worker's claim expires instead of wedging the queue.
    ///
    /// # Errors
    ///
    /// Returns an error when due events cannot be queried, leased, or committed.
    pub async fn claim_outbox_batch(
        &self,
        limit: i64,
        lease_seconds: i64,
    ) -> anyhow::Result<Vec<OutboxEvent>> {
        let now = Utc::now();
        let mut transaction = self.pool.begin().await?;
        let rows = sqlx::query(
            "SELECT id, event_type, payload_json, created_at, attempts FROM outbox_events \
             WHERE published_at IS NULL AND (available_at IS NULL OR available_at <= ?) \
             ORDER BY created_at, id LIMIT ?",
        )
        .bind(now.to_rfc3339())
        .bind(limit)
        .fetch_all(&mut *transaction)
        .await?;
        let events: Vec<OutboxEvent> = rows
            .into_iter()
            .map(|row| OutboxEvent {
                id: row.get("id"),
                event_type: row.get("event_type"),
                payload_json: row.get("payload_json"),
                created_at: row.get("created_at"),
                attempts: row.get("attempts"),
            })
            .collect();
        if !events.is_empty() {
            let lease = (now + chrono::Duration::seconds(lease_seconds)).to_rfc3339();
            for event in &events {
                sqlx::query("UPDATE outbox_events SET available_at = ? WHERE id = ?")
                    .bind(&lease)
                    .bind(&event.id)
                    .execute(&mut *transaction)
                    .await?;
            }
        }
        transaction.commit().await?;
        Ok(events)
    }

    /// Mark selected outbox events as published in one transaction.
    ///
    /// # Errors
    ///
    /// Returns an error when an update or transaction commit fails.
    pub async fn mark_outbox_published(&self, ids: &[String]) -> anyhow::Result<()> {
        let now = Utc::now().to_rfc3339();
        let mut transaction = self.pool.begin().await?;
        for id in ids {
            sqlx::query(
                "UPDATE outbox_events SET published_at = ?, last_error = NULL WHERE id = ?",
            )
            .bind(&now)
            .bind(id)
            .execute(&mut *transaction)
            .await?;
        }
        transaction.commit().await?;
        Ok(())
    }

    /// Compensation for a failed delivery: release the claim, count the
    /// attempt, and back the event off so retries do not spin.
    ///
    /// # Errors
    ///
    /// Returns an error when an update or transaction commit fails.
    pub async fn park_outbox(
        &self,
        ids: &[String],
        error: &str,
        backoff_seconds: i64,
    ) -> anyhow::Result<()> {
        let available = (Utc::now() + chrono::Duration::seconds(backoff_seconds)).to_rfc3339();
        let mut transaction = self.pool.begin().await?;
        for id in ids {
            sqlx::query(
                "UPDATE outbox_events SET available_at = ?, attempts = attempts + 1, last_error = ? \
                 WHERE id = ? AND published_at IS NULL",
            )
            .bind(&available)
            .bind(error)
            .bind(id)
            .execute(&mut *transaction)
            .await?;
        }
        transaction.commit().await?;
        Ok(())
    }

    /// Terminal compensation for a poison event: record the failure and stop
    /// retrying. Full-snapshot resync reconciles whatever the event described.
    ///
    /// # Errors
    ///
    /// Returns an error when an update or transaction commit fails.
    pub async fn dead_letter_outbox(&self, ids: &[String], error: &str) -> anyhow::Result<()> {
        let now = Utc::now().to_rfc3339();
        let mut transaction = self.pool.begin().await?;
        for id in ids {
            sqlx::query(
                "UPDATE outbox_events SET published_at = ?, last_error = ? WHERE id = ? AND published_at IS NULL",
            )
            .bind(&now)
            .bind(error)
            .bind(id)
            .execute(&mut *transaction)
            .await?;
        }
        transaction.commit().await?;
        Ok(())
    }

    /// Count outbox events that have not been published.
    ///
    /// # Errors
    ///
    /// Returns an error when the count query fails.
    pub async fn count_unpublished_outbox(&self) -> anyhow::Result<i64> {
        Ok(
            sqlx::query("SELECT COUNT(*) AS count FROM outbox_events WHERE published_at IS NULL")
                .fetch_one(&self.pool)
                .await?
                .get("count"),
        )
    }

    // —— certificate authority and issuance —————————————————————
}
