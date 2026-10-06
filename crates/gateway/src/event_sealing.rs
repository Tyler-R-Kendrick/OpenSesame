//! The Host's event rows rest sealed (ADR 0157).
//!
//! The outbox, security deliveries, connection events, signing events, approval
//! comments, runner steps and receipts are sealed before they reach the `SQLite`
//! file, under a key derived from the Host sealing key
//! (`OPENSESAME_CONNECTION_KEY`). The sealer is installed here, before anything
//! writes an event, and legacy values are refused unless an operator explicitly enables import.
//!
//! A Host that is networked or in production and has no sealing key refuses to
//! start: it would otherwise keep its history in the clear. On a development
//! Host the events are stored unsealed and the log says so.

use opensesame_connection_broker::BrokerConfig;
use opensesame_storage::Db;

/// Install the event sealer and validate existing rows, or explicitly import legacy rows.
///
/// # Errors
///
/// Returns an error when a production Host has no sealing key, or when an
/// an existing row is legacy without explicit import, or cannot be sealed or scrubbed.
pub async fn install(db: &Db, config: &BrokerConfig, production: bool) -> anyhow::Result<()> {
    scrub_failure_text(db).await?;
    match config.key() {
        Some(key) => seal_events(db, key).await,
        None if production => anyhow::bail!(
            "OPENSESAME_CONNECTION_KEY must be set on a networked or production Host: the Host's events (outbox, deliveries, receipts, signing and approval records) are sealed at rest under it"
        ),
        None => {
            tracing::warn!(
                "OPENSESAME_CONNECTION_KEY is not set: this development Host stores its events unsealed"
            );
            Ok(())
        }
    }
}

/// Scrub the failure text an older build stored as it came.
async fn scrub_failure_text(db: &Db) -> anyhow::Result<()> {
    let scrubbed = db.scrub_legacy_failure_text().await?;
    if scrubbed > 0 {
        tracing::info!(
            scrubbed,
            "scrubbed failure text an older build stored as it came"
        );
    }
    Ok(())
}

/// Install the sealer, then validate current rows or explicitly import trusted legacy rows.
async fn seal_events(db: &Db, key: &[u8; 32]) -> anyhow::Result<()> {
    opensesame_event_seal::install(key);
    if std::env::var("OPENSESAME_ALLOW_LEGACY_SECRET_MIGRATION").as_deref() != Ok("true") {
        return db.validate_current_event_envelopes().await;
    }
    tracing::warn!("explicit trusted legacy secret import enabled; disable OPENSESAME_ALLOW_LEGACY_SECRET_MIGRATION after upgrade");
    let sealed = db.seal_legacy_events().await?;
    if sealed > 0 {
        tracing::info!(
            sealed,
            "sealed event values an older build left in the clear"
        );
    }
    db.validate_current_event_envelopes().await
}
