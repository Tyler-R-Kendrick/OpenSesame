//! A queued row whose sealed value will not open is set aside, not retried
//! (ADR 0156).
//!
//! A claim loop that failed its whole batch on one unreadable row (a key that
//! changed, a value that was altered) would fail again on every tick and hold
//! every newer row behind it. The row is instead marked failed through the
//! table's own failure columns, with a reason that names no value, and the rest
//! of the batch goes on. The sealed value is left exactly as it was, so
//! restoring the key and clearing the failure recovers it.

use chrono::{DateTime, Utc};
use sqlx::{Sqlite, Transaction};

use super::UNREADABLE;

/// Dead-letter outbox events the way [`crate::Db::dead_letter_outbox`] does:
/// stop retrying, keep the row.
pub(crate) async fn quarantine_outbox(
    transaction: &mut Transaction<'_, Sqlite>,
    ids: &[String],
    now: DateTime<Utc>,
) -> anyhow::Result<()> {
    for id in ids {
        tracing::warn!(event_id = %id, "outbox event quarantined: its sealed value did not open");
        sqlx::query(
            "UPDATE outbox_events SET published_at = ?, last_error = ? \
             WHERE id = ? AND published_at IS NULL",
        )
        .bind(now.to_rfc3339())
        .bind(UNREADABLE)
        .bind(id)
        .execute(&mut **transaction)
        .await?;
    }
    Ok(())
}

/// Dead-letter security deliveries the way
/// [`crate::Db::dead_letter_security_delivery`] does.
pub(crate) async fn quarantine_deliveries(
    transaction: &mut Transaction<'_, Sqlite>,
    ids: &[String],
    now: DateTime<Utc>,
) -> anyhow::Result<()> {
    for id in ids {
        tracing::warn!(delivery_id = %id, "security delivery quarantined: its sealed value did not open");
        sqlx::query(
            "UPDATE security_deliveries SET state = 'dead_lettered', attempts = attempts + 1, \
             available_at = NULL, last_error = ?, updated_at = ? WHERE id = ?",
        )
        .bind(UNREADABLE)
        .bind(now.to_rfc3339())
        .bind(id)
        .execute(&mut **transaction)
        .await?;
    }
    Ok(())
}
