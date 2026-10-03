//! The Host's event rows rest sealed (ADR 0155).
//!
//! The outbox, security deliveries, connection events, signing events, approval
//! comments, runner steps and receipts are sealed before they reach the `SQLite`
//! file, under a key derived from the Host sealing key
//! (`OPENSESAME_CONNECTION_KEY`). The sealer is installed here, before anything
//! writes an event, and what an older build left in the clear is sealed in place.
//!
//! A Host that is networked or in production and has no sealing key refuses to
//! start: it would otherwise keep its history in the clear. On a development
//! Host the events are stored unsealed and the log says so.

use opensesame_connection_broker::BrokerConfig;
use opensesame_storage::Db;

/// Install the event sealer and seal existing rows.
///
/// # Errors
///
/// Returns an error when a production Host has no sealing key, or when an
/// existing row cannot be sealed or scrubbed.
pub async fn install(db: &Db, config: &BrokerConfig, production: bool) -> anyhow::Result<()> {
    let scrubbed = db.scrub_legacy_failure_text().await?;
    if scrubbed > 0 {
        tracing::info!(
            scrubbed,
            "scrubbed failure text an older build stored as it came"
        );
    }
    match config.key() {
        Some(key) => {
            opensesame_event_seal::install(key);
            let sealed = db.seal_legacy_events().await?;
            if sealed > 0 {
                tracing::info!(sealed, "sealed event values an older build left in the clear");
            }
            Ok(())
        }
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
