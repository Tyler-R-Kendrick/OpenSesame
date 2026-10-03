//! Reading a security delivery back: its payload rests sealed (ADR 0156).

use sqlx::{sqlite::SqliteRow, Row};

use crate::sealed;
use crate::security::StoredSecurityDelivery;

pub(crate) fn delivery_from_row(row: &SqliteRow) -> anyhow::Result<StoredSecurityDelivery> {
    let stored: String = row.get("payload_json");
    Ok(StoredSecurityDelivery {
        id: row.get("id"),
        organization_id: row.get("organization_id"),
        hook_id: row.get("hook_id"),
        event_type: row.get("event_type"),
        subject_kind: row.get("subject_kind"),
        subject_id: row.get("subject_id"),
        payload_json: sealed::open("security_deliveries.payload_json", &stored)?,
        state: row.get("state"),
        attempts: row.get("attempts"),
        available_at: row.get("available_at"),
        last_error: row.get("last_error"),
        delivered_at: row.get("delivered_at"),
        created_at: row.get("created_at"),
        updated_at: row.get("updated_at"),
    })
}

/// The deliveries in `rows` that open. Those that do not (a changed key, an
/// altered value) are dead-lettered inside `transaction` instead of failing the
/// whole claim, so one bad row cannot hold every newer one behind it.
///
/// # Errors
///
/// Fails when no sealer is installed to open a sealed value, or on a database
/// error.
pub(crate) async fn readable_deliveries(
    transaction: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    rows: &[SqliteRow],
    now: chrono::DateTime<chrono::Utc>,
) -> anyhow::Result<Vec<StoredSecurityDelivery>> {
    let (mut readable, mut unreadable) = (Vec::new(), Vec::new());
    for row in rows {
        let stored: String = row.get("payload_json");
        if sealed::open_or_quarantine("security_deliveries.payload_json", &stored)?.is_some() {
            readable.push(delivery_from_row(row)?);
        } else {
            unreadable.push(row.get("id"));
        }
    }
    sealed::quarantine::quarantine_deliveries(transaction, &unreadable, now).await?;
    Ok(readable)
}
