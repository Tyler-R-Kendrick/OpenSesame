//! A connection event read back: its detail rests sealed (ADR 0157).

use sqlx::{sqlite::SqliteRow, Row};

use crate::error::{BrokerError, Result};
use crate::model::EventView;

pub(crate) fn event_view(row: &SqliteRow) -> Result<EventView> {
    let stored: Option<String> = row.get("detail");
    let id: String = row.get("id");
    let organization: String = row.get("organization_id");
    let connection: String = row.get("connection_id");
    let record = record_context(&connection, &id);
    let detail = stored
        .map(|value| {
            opensesame_event_seal::open_in(
                &organization,
                "connection_events.detail",
                &record,
                &value,
            )
        })
        .transpose()
        .map_err(|error| BrokerError::SealUnavailable(error.to_string()))?;
    Ok(EventView {
        id,
        kind: row.get("kind"),
        detail,
        at: row.get("at"),
    })
}

pub(super) fn record_context(connection_id: &str, event_id: &str) -> String {
    format!("{}:{connection_id}{event_id}", connection_id.len())
}
