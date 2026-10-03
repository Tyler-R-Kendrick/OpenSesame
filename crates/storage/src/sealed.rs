//! The Host's event and audit rows rest sealed (ADR 0157).
//!
//! Thin wrappers over `opensesame-event-seal` so a call site names its column
//! once and reads or writes text; a sealed value that does not open surfaces as
//! an error, never as ciphertext handed on as if it were the event.

use anyhow::Context as _;
use sqlx::Row as _;

use super::Db;

pub(crate) mod quarantine;

/// Seal a value for `column` (`table.column`); plaintext when no sealer is installed.
pub(crate) fn seal(column: &str, text: &str) -> String {
    opensesame_event_seal::seal(column, text)
}

/// A value opened, or an error naming the column.
pub(crate) fn open(column: &str, stored: &str) -> anyhow::Result<String> {
    opensesame_event_seal::open(column, stored).map_err(anyhow::Error::new)
}

/// [`seal`] for a column that may be null.
pub(crate) fn seal_opt(column: &str, text: Option<&str>) -> Option<String> {
    text.map(|plain| seal(column, plain))
}

/// [`open`] for a row a claim loop reads: `Ok(None)` is a value that does not
/// open while a sealer is installed (a changed key, an altered row), which the
/// caller quarantines instead of failing its whole batch. With no sealer
/// installed nothing can open, so that stays an error: a missing key at start
/// must not dead-letter a queue.
pub(crate) fn open_or_quarantine(column: &str, stored: &str) -> anyhow::Result<Option<String>> {
    match opensesame_event_seal::open(column, stored) {
        Ok(plain) => Ok(Some(plain)),
        Err(_) if opensesame_event_seal::is_active() => Ok(None),
        Err(error) => Err(anyhow::Error::new(error)),
    }
}

/// The value-free reason written on a row whose sealed value did not open.
pub(crate) const UNREADABLE: &str = "unreadable: sealed value did not open";

pub(crate) fn open_opt(column: &str, stored: Option<String>) -> anyhow::Result<Option<String>> {
    opensesame_event_seal::open_opt(column, stored).map_err(anyhow::Error::new)
}

/// Failure text is scrubbed rather than sealed: an operator reads it, and a
/// transport error can echo a URL with a token in it.
pub(crate) fn scrub(text: &str) -> String {
    opensesame_redaction::redact_text(text)
}

/// Every `(table, key column, text column)` an older build wrote failure text
/// into without scrubbing it.
const SCRUBBED_COLUMNS: &[(&str, &str, &str)] = &[
    ("outbox_events", "id", "last_error"),
    ("security_deliveries", "id", "last_error"),
    ("security_hooks", "id", "last_error"),
    ("connections", "id", "status_detail"),
    ("sync_targets", "id", "status_detail"),
];

/// Every `(table, key column, sealed column)` an event value rests in.
const SEALED_COLUMNS: &[(&str, &str, &str)] = &[
    ("outbox_events", "id", "payload_json"),
    ("security_deliveries", "id", "payload_json"),
    ("connection_events", "id", "detail"),
    ("signing_events", "id", "command"),
    ("signing_events", "id", "hostname"),
    ("signing_events", "id", "os_username"),
    ("signing_events", "id", "ip"),
    ("approval_decisions", "id", "comment"),
    ("runner_steps", "rowid", "request_json"),
    ("runner_steps", "rowid", "outcome_json"),
    ("intents", "id", "body_json"),
    ("invocations", "id", "body_json"),
    ("receipts", "id", "body_json"),
];

impl Db {
    /// Seal every event value an older build left in the clear, in place.
    /// Idempotent: a sealed value is skipped, so an interrupted pass resumes.
    /// "Sealed" is the exact, case-sensitive `osev1.` prefix, the same test
    /// [`opensesame_event_seal::open`] makes on read (a `LIKE` here would be
    /// case-insensitive and leave an `OSEV1.` plaintext in the clear). A
    /// plaintext that begins with the exact prefix is indistinguishable from a
    /// sealed value and is not swept.
    /// Returns how many values were sealed.
    ///
    /// # Errors
    ///
    /// Returns an error when a row cannot be read or rewritten.
    pub async fn seal_legacy_events(&self) -> anyhow::Result<usize> {
        if !opensesame_event_seal::is_active() {
            return Ok(0);
        }
        let mut sealed = 0;
        for (table, key, column) in SEALED_COLUMNS {
            sealed += self.seal_legacy_column(table, key, column).await?;
        }
        Ok(sealed)
    }

    /// Scrub failure text an older build stored as it came. Idempotent: text
    /// the scrubber leaves as it is is not rewritten, so a second pass finds
    /// nothing. A table the deployment has not created is skipped. Returns how
    /// many values were rewritten.
    ///
    /// # Errors
    ///
    /// Returns an error when a row cannot be read or rewritten.
    pub async fn scrub_legacy_failure_text(&self) -> anyhow::Result<usize> {
        let mut scrubbed = 0;
        for (table, key, column) in SCRUBBED_COLUMNS {
            let exists: i64 = sqlx::query_scalar(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?",
            )
            .bind(table)
            .fetch_one(&self.pool)
            .await
            .with_context(|| format!("looking for {table}"))?;
            if exists == 0 {
                continue;
            }
            scrubbed += self.scrub_legacy_column(table, key, column).await?;
        }
        Ok(scrubbed)
    }

    async fn scrub_legacy_column(
        &self,
        table: &str,
        key: &str,
        column: &str,
    ) -> anyhow::Result<usize> {
        let select = format!(
            "SELECT {key} AS k, {column} AS v FROM {table} WHERE {column} IS NOT NULL AND {column} <> ''"
        );
        let update = format!("UPDATE {table} SET {column} = ? WHERE {key} = ?");
        let rows = sqlx::query(&select)
            .fetch_all(&self.pool)
            .await
            .with_context(|| format!("reading legacy {table}.{column}"))?;
        let mut scrubbed = 0;
        for row in &rows {
            let text: String = row.get("v");
            let clean = scrub(&text);
            if clean == text {
                continue;
            }
            let done = sqlx::query(&update).bind(clean);
            let done = match row.try_get::<String, _>("k") {
                Ok(id) => done.bind(id),
                Err(_) => done.bind(row.get::<i64, _>("k")),
            };
            done.execute(&self.pool)
                .await
                .with_context(|| format!("scrubbing legacy {table}.{column}"))?;
            scrubbed += 1;
        }
        Ok(scrubbed)
    }

    async fn seal_legacy_column(
        &self,
        table: &str,
        key: &str,
        column: &str,
    ) -> anyhow::Result<usize> {
        let qualified = format!("{table}.{column}");
        let select = format!(
            "SELECT {key} AS k, {column} AS v FROM {table} \
             WHERE {column} IS NOT NULL AND {column} <> '' AND substr({column}, 1, {len}) <> '{prefix}' LIMIT 500",
            prefix = opensesame_event_seal::PREFIX,
            len = opensesame_event_seal::PREFIX.len()
        );
        let update = format!("UPDATE {table} SET {column} = ? WHERE {key} = ?");
        let mut sealed = 0;
        loop {
            let rows = sqlx::query(&select)
                .fetch_all(&self.pool)
                .await
                .with_context(|| format!("reading legacy {qualified}"))?;
            if rows.is_empty() {
                return Ok(sealed);
            }
            for row in &rows {
                self.seal_legacy_row(&update, &qualified, row).await?;
            }
            sealed += rows.len();
        }
    }

    async fn seal_legacy_row(
        &self,
        update: &str,
        qualified: &str,
        row: &sqlx::sqlite::SqliteRow,
    ) -> anyhow::Result<()> {
        let plain: String = row.get("v");
        let done = sqlx::query(update).bind(seal(qualified, &plain));
        // The key is text for most tables and the rowid for one.
        let done = match row.try_get::<String, _>("k") {
            Ok(id) => done.bind(id),
            Err(_) => done.bind(row.get::<i64, _>("k")),
        };
        done.execute(&self.pool)
            .await
            .with_context(|| format!("sealing legacy {qualified}"))?;
        Ok(())
    }
}
