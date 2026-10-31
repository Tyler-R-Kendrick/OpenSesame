//! The mint register (ADR 0217, ADR 0074): what the lifecycle scanner needs to
//! publish a minted credential's expiry, and no more — a grant id, the
//! connection, the organization and the deadline — in plain columns, because
//! collection never opens a seal. The mint's receipt, with the role and STS's
//! request id, is the connection event, sealed by the event path.

use chrono::{DateTime, Utc};
use sqlx::sqlite::SqliteRow;
use sqlx::{Row, SqlitePool};

use super::store::stamp;
use crate::Result;

/// Create the table when absent.
///
/// # Errors
///
/// Returns an error when the schema cannot be created.
pub async fn ensure_schema(pool: &SqlitePool) -> Result<()> {
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS aws_sts_mints (
            grant_id TEXT PRIMARY KEY,
            connection_id TEXT NOT NULL,
            organization_id TEXT NOT NULL,
            expires_at TEXT NOT NULL,
            issued_at TEXT NOT NULL
         )",
    )
    .execute(pool)
    .await?;
    sqlx::query(
        "CREATE INDEX IF NOT EXISTS idx_aws_sts_mints_org_expiry \
         ON aws_sts_mints(organization_id, expires_at)",
    )
    .execute(pool)
    .await?;
    Ok(())
}

/// One minted credential's deadline.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MintDeadline {
    pub grant_id: String,
    pub connection_id: String,
    pub organization_id: String,
    pub expires_at: DateTime<Utc>,
}

/// Register a mint's deadline.
///
/// # Errors
///
/// Returns an error when storage fails.
pub async fn record_mint(
    pool: &SqlitePool,
    deadline: &MintDeadline,
    issued_at: DateTime<Utc>,
) -> Result<()> {
    ensure_schema(pool).await?;
    sqlx::query(
        "INSERT INTO aws_sts_mints (grant_id, connection_id, organization_id, expires_at, issued_at) \
         VALUES (?, ?, ?, ?, ?)",
    )
    .bind(&deadline.grant_id)
    .bind(&deadline.connection_id)
    .bind(&deadline.organization_id)
    .bind(stamp(deadline.expires_at))
    .bind(stamp(issued_at))
    .execute(pool)
    .await?;
    Ok(())
}

/// The deadlines one lifecycle pass collects in one organization: up to
/// `limit` still live at `now`, soonest first, then up to `limit` that lapsed
/// after `since`, most recently lapsed first.
///
/// Two bounded reads, not one. A lapsed mint stays in the register through
/// the grace window after its `expired` rung is published, and read together
/// soonest first, a full pass of those rows would keep every newer credential
/// out of collection: no notice while it lives, and no `expired` until the old
/// rows leave the window a day later. Read apart, a live mint competes only
/// with mints that end before it, and a lapsed one only with mints that lapsed
/// after it.
///
/// # Errors
///
/// Returns an error when storage fails.
pub async fn mints_to_scan(
    pool: &SqlitePool,
    organization_id: &str,
    now: DateTime<Utc>,
    since: DateTime<Utc>,
    limit: i64,
) -> Result<Vec<MintDeadline>> {
    ensure_schema(pool).await?;
    let now = stamp(now);
    let live = sqlx::query(
        "SELECT grant_id, connection_id, organization_id, expires_at FROM aws_sts_mints \
         WHERE organization_id = ? AND expires_at > ? \
         ORDER BY expires_at ASC, grant_id ASC LIMIT ?",
    )
    .bind(organization_id)
    .bind(&now)
    .bind(limit)
    .fetch_all(pool)
    .await?;
    let lapsed = sqlx::query(
        "SELECT grant_id, connection_id, organization_id, expires_at FROM aws_sts_mints \
         WHERE organization_id = ? AND expires_at > ? AND expires_at <= ? \
         ORDER BY expires_at DESC, grant_id DESC LIMIT ?",
    )
    .bind(organization_id)
    .bind(stamp(since))
    .bind(&now)
    .bind(limit)
    .fetch_all(pool)
    .await?;
    live.iter().chain(&lapsed).map(deadline).collect()
}

fn deadline(row: &SqliteRow) -> Result<MintDeadline> {
    let expires_at: String = row.try_get("expires_at")?;
    Ok(MintDeadline {
        grant_id: row.try_get("grant_id")?,
        connection_id: row.try_get("connection_id")?,
        organization_id: row.try_get("organization_id")?,
        expires_at: DateTime::parse_from_rfc3339(&expires_at)
            .map_err(|_| crate::BrokerError::Invalid("stored deadline is unreadable".into()))?
            .with_timezone(&Utc),
    })
}

#[cfg(test)]
#[path = "register_tests.rs"]
mod tests;
