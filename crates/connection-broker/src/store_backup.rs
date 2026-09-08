//! Organization-bound transactional backup outbox writes.
use crate::error::Result;
use chrono::Utc;

/// Broadcast a secret-change event in the same transaction as the mutation it
/// describes (transactional outbox, ADR 0039). The backup actor drains these;
/// payloads carry references only, never material.
pub(super) async fn append_backup_outbox(
    transaction: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    event_type: &str,
    connection_id: &str,
    detail: &str,
) -> Result<()> {
    let organization: Option<String> = if event_type.starts_with("config.") {
        sqlx::query_scalar("SELECT organization_id FROM secret_configs WHERE id=?")
            .bind(connection_id)
            .fetch_optional(&mut **transaction)
            .await?
    } else {
        sqlx::query_scalar("SELECT organization_id FROM connections WHERE id=?")
            .bind(connection_id)
            .fetch_optional(&mut **transaction)
            .await?
    };
    sqlx::query(
        "INSERT INTO outbox_events (id, event_type, payload_json, created_at) VALUES (?, ?, ?, ?)",
    )
    .bind(uuid::Uuid::now_v7().to_string())
    .bind(event_type)
    .bind(serde_json::json!({"organization_id": organization, "connection_id": connection_id, "detail": detail}).to_string())
    .bind(Utc::now().to_rfc3339())
    .execute(&mut **transaction)
    .await?;
    Ok(())
}
