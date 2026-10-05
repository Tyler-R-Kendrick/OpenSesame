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

/// Seal tenant-owned text with an authoritative customer and stable row identity.
pub(crate) fn seal_in(customer: &str, column: &str, resource: &str, text: &str) -> String {
    opensesame_event_seal::seal_in(customer, column, resource, text)
}

pub(crate) fn open_in(
    customer: &str,
    column: &str,
    resource: &str,
    stored: &str,
) -> anyhow::Result<String> {
    opensesame_event_seal::open_in(customer, column, resource, stored).map_err(anyhow::Error::new)
}

pub(crate) fn seal_opt_in(
    customer: &str,
    column: &str,
    resource: &str,
    text: Option<&str>,
) -> Option<String> {
    text.map(|text| seal_in(customer, column, resource, text))
}

pub(crate) fn open_opt_in(
    customer: &str,
    column: &str,
    resource: &str,
    stored: Option<String>,
) -> anyhow::Result<Option<String>> {
    stored
        .map(|stored| open_in(customer, column, resource, &stored))
        .transpose()
}

pub(crate) fn open_or_quarantine_in(
    customer: &str,
    column: &str,
    resource: &str,
    stored: &str,
) -> anyhow::Result<Option<String>> {
    match open_in(customer, column, resource, stored) {
        Ok(plain) => Ok(Some(plain)),
        Err(_) if opensesame_event_seal::is_active() => Ok(None),
        Err(error) => Err(error),
    }
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
    /// Idempotent: current envelopes are skipped. Legacy encrypted values are
    /// opened with the deployment key, then rebound to authoritative customer
    /// and record columns. Unbound deployment events retain deployment scope.
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
        let binding = match table {
            "security_deliveries" | "signing_events" | "approval_decisions" | "intents" | "outbox_events" | "runner_steps" => "organization_id",
            "connection_events" => "(SELECT organization_id FROM connections WHERE connections.id = connection_events.connection_id)",
            "invocations" => "(SELECT organization_id FROM intents WHERE intents.id = invocations.intent_id)",
            "receipts" => "(SELECT i.organization_id FROM invocations inv JOIN intents i ON i.id = inv.intent_id WHERE inv.id = receipts.invocation_id)",
            _ => "NULL",
        };
        let record = if table == "connection_events" {
            "length(connection_id) || ':' || connection_id || id"
        } else if table == "runner_steps" {
            "run_id || ':' || seq"
        } else {
            key
        };
        let select = format!(
            "SELECT {key} AS k, {column} AS v, {binding} AS customer, {record} AS record FROM {table} \
             WHERE {column} IS NOT NULL AND {column} <> '' AND substr({column}, 1, {len}) <> '{prefix}' LIMIT 500",
            prefix = opensesame_event_seal::PREFIX,
            len = opensesame_event_seal::PREFIX.len()
        );
        let assignment = if table == "outbox_events" {
            format!("{column} = ?, organization_id = ?")
        } else {
            format!("{column} = ?")
        };
        let update = format!("UPDATE {table} SET {assignment} WHERE {key} = ? AND {column} = ? AND {binding} IS ? AND CAST({record} AS TEXT) = ?");
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
                sealed += self.seal_legacy_row(&update, &qualified, row).await?;
            }
        }
    }

    async fn legacy_outbox_customer(&self, plain: &str) -> anyhow::Result<Option<String>> {
        let Ok(payload) = serde_json::from_str::<serde_json::Value>(plain) else {
            return Ok(None);
        };
        if let Some(customer) = payload
            .get("organization_id")
            .and_then(serde_json::Value::as_str)
        {
            return Ok(Some(customer.to_owned()));
        }
        let Some(vault) = payload.get("vault_id").and_then(serde_json::Value::as_str) else {
            return Ok(None);
        };
        sqlx::query_scalar("SELECT organization_id FROM vaults WHERE id = ?")
            .bind(vault)
            .fetch_optional(&self.pool)
            .await
            .map_err(anyhow::Error::new)
    }

    async fn seal_legacy_row(
        &self,
        update: &str,
        qualified: &str,
        row: &sqlx::sqlite::SqliteRow,
    ) -> anyhow::Result<usize> {
        let stored: String = row.get("v");
        let plain = opensesame_event_seal::open(qualified, &stored).map_err(anyhow::Error::new)?;
        let original_customer: Option<String> = row.get("customer");
        let mut customer = original_customer.clone();
        let outbox = qualified == "outbox_events.payload_json";
        if outbox && customer.is_none() {
            customer = self.legacy_outbox_customer(&plain).await?;
        }
        let record = row
            .try_get::<String, _>("record")
            .unwrap_or_else(|_| row.get::<i64, _>("record").to_string());
        let sealed = match &customer {
            Some(customer) => seal_in(customer, qualified, &record, &plain),
            None => seal(qualified, &plain),
        };
        let done = sqlx::query(update).bind(sealed);
        let done = if outbox { done.bind(customer) } else { done };
        let done = match row.try_get::<String, _>("k") {
            Ok(id) => done.bind(id),
            Err(_) => done.bind(row.get::<i64, _>("k")),
        };
        let affected = done
            .bind(stored)
            .bind(original_customer)
            .bind(record)
            .execute(&self.pool)
            .await
            .with_context(|| format!("sealing legacy {qualified}"))?
            .rows_affected();
        Ok(usize::from(affected != 0))
    }
}

#[cfg(test)]
mod tests {
    use super::Db;
    use sqlx::Row;

    #[tokio::test]
    async fn legacy_rewrite_preserves_a_value_changed_after_its_snapshot() {
        let db = Db::connect_memory().await.unwrap();
        sqlx::query("INSERT INTO outbox_events (id, event_type, payload_json, created_at) VALUES ('event', 'test', '{}', 'now')")
            .execute(db.pool()).await.unwrap();
        let snapshot = sqlx::query("SELECT id AS k, payload_json AS v, organization_id AS customer, id AS record FROM outbox_events WHERE id = 'event'")
            .fetch_one(db.pool()).await.unwrap();
        sqlx::query("UPDATE outbox_events SET payload_json = 'new-value' WHERE id = 'event'")
            .execute(db.pool())
            .await
            .unwrap();
        let affected = db.seal_legacy_row(
            "UPDATE outbox_events SET payload_json = ?, organization_id = ? WHERE id = ? AND payload_json = ? AND organization_id IS ? AND CAST(id AS TEXT) = ?",
            "outbox_events.payload_json", &snapshot,
        ).await.unwrap();
        assert_eq!(affected, 0);
        let row = sqlx::query(
            "SELECT payload_json, organization_id FROM outbox_events WHERE id = 'event'",
        )
        .fetch_one(db.pool())
        .await
        .unwrap();
        assert_eq!(row.get::<String, _>("payload_json"), "new-value");
        assert!(row.get::<Option<String>, _>("organization_id").is_none());
    }
}
