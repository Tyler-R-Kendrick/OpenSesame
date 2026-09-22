//! Persistence of a connection's transport record (ADR 0130, CONN-MODEL).
//!
//! Additive: one nullable `transport_json` column on `connections`
//! (`migrations/0040_connection_transport.sql`). A connection with no record
//! reads as `None` and behaves exactly as it did before mTLS existed.
//!
//! Every statement here is scoped by `organization_id` as well as `id`. A
//! connection in another tenant reads as absent rather than forbidden, which
//! is the same non-oracle rule `ConnectionBroker::row_in_org` follows, and it
//! is what keeps tenant B's transport record (and therefore tenant B's
//! identity reference) unreachable through tenant A's connection id
//! (AT-TLS-TENANT, AT-CUSTODY-SOURCE).
//!
//! The record holds *references only*. Nothing sealed, nothing secret, and no
//! locator: [`ConnectionTransport::parse_json`] refuses a path, a URL, a
//! socket or a PEM block before a row ever becomes a value.

use sqlx::{Row, SqlitePool};

use super::ConnectionTransport;
use crate::error::{BrokerError, Result};

/// Read a connection's transport record.
///
/// # Errors
///
/// `Storage` when the row cannot be read; `Invalid` when a persisted record
/// no longer parses — an invalid stored transport setting fails closed and is
/// never silently treated as "no mTLS configured" (cross-swarm rule
/// *Configuration is authority*).
pub async fn get(
    pool: &SqlitePool,
    organization_id: &str,
    connection_id: &str,
) -> Result<Option<ConnectionTransport>> {
    let found =
        sqlx::query("SELECT transport_json FROM connections WHERE id = ? AND organization_id = ?")
            .bind(connection_id)
            .bind(organization_id)
            .fetch_optional(pool)
            .await?;
    let Some(row) = found else {
        return Ok(None);
    };
    let Some(stored) = row.get::<Option<String>, _>("transport_json") else {
        return Ok(None);
    };
    ConnectionTransport::parse_json(stored.as_bytes())
        .map(Some)
        .map_err(|error| BrokerError::Invalid(format!("stored connection transport: {error}")))
}

/// Write (or clear, with `None`) a connection's transport record.
///
/// # Errors
///
/// `Invalid` when the record does not validate or when the connection does not
/// exist in this organization; `Storage` when the write fails.
pub async fn set(
    pool: &SqlitePool,
    organization_id: &str,
    connection_id: &str,
    transport: Option<&ConnectionTransport>,
) -> Result<()> {
    let json = match transport {
        Some(record) => {
            record
                .validate()
                .map_err(|error| BrokerError::Invalid(format!("connection transport: {error}")))?;
            Some(
                record
                    .to_json()
                    .map_err(|error| BrokerError::Invalid(error.to_string()))?,
            )
        }
        None => None,
    };
    let changed = sqlx::query(
        "UPDATE connections SET transport_json = ?, updated_at = ? \
         WHERE id = ? AND organization_id = ?",
    )
    .bind(json)
    .bind(chrono::Utc::now().to_rfc3339())
    .bind(connection_id)
    .bind(organization_id)
    .execute(pool)
    .await?
    .rows_affected();
    if changed == 0 {
        return Err(BrokerError::ConnectionNotFound);
    }
    Ok(())
}
