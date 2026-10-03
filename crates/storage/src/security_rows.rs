//! Reading a security delivery back: its payload rests sealed (ADR 0150).

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
