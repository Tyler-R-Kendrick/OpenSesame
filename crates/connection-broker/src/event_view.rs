//! A connection event read back: its detail rests sealed (ADR 0156).

use sqlx::{sqlite::SqliteRow, Row};

use crate::error::{BrokerError, Result};
use crate::model::EventView;

pub(crate) fn event_view(row: &SqliteRow) -> Result<EventView> {
    let stored: Option<String> = row.get("detail");
    Ok(EventView {
        id: row.get("id"),
        kind: row.get("kind"),
        detail: opensesame_event_seal::open_opt("connection_events.detail", stored)
            .map_err(|error| BrokerError::SealUnavailable(error.to_string()))?,
        at: row.get("at"),
    })
}
