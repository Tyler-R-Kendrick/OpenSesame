//! Customer-bound connection event writes within the caller transaction.

use crate::error::{BrokerError, Result};
use crate::model::EventKind;

pub(super) async fn append_connection_event(
    transaction: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    connection_id: &str,
    kind: EventKind,
    detail: Option<&str>,
    at: &str,
) -> Result<()> {
    let organization: String =
        sqlx::query_scalar("SELECT organization_id FROM connections WHERE id = ?")
            .bind(connection_id)
            .fetch_optional(&mut **transaction)
            .await?
            .ok_or(BrokerError::ConnectionNotFound)?;
    let event_id = uuid::Uuid::now_v7().to_string();
    let record = super::event_view::record_context(connection_id, &event_id);
    let sealed = detail.map(|value| {
        opensesame_event_seal::seal_in(&organization, "connection_events.detail", &record, value)
    });
    sqlx::query("INSERT INTO connection_events (id, connection_id, kind, detail, at) VALUES (?, ?, ?, ?, ?)")
        .bind(&event_id)
        .bind(connection_id)
        .bind(kind.as_str())
        .bind(sealed)
        .bind(at)
        .execute(&mut **transaction)
        .await?;
    Ok(())
}
