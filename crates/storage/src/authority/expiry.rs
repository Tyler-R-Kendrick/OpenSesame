//! Deadlines for the lifecycle scanner (ADR 0120 §5 / INV-GA-05).
//!
//! Value-blind: grant id, organization, and the interval only. No permission
//! entries, digests, or secret-shaped columns leave this query.

use chrono::{DateTime, Utc as ChronoUtc};
use sqlx::sqlite::SqliteRow;
use sqlx::Row;

use crate::Db;

/// Unrevoked sidecars still live at `?2`, soonest first.
const LIVE: &str = "SELECT a.grant_id, a.organization_id, a.not_before, a.expires_at \
     FROM grant_authority a \
     JOIN grants g ON g.id = a.grant_id AND g.organization_id = a.organization_id \
     WHERE a.organization_id = ?1 AND g.revoked_at IS NULL AND a.expires_at > ?2 \
     ORDER BY a.expires_at ASC, a.grant_id ASC LIMIT ?3";

/// Unrevoked sidecars that lapsed at or before `?2`, most recently lapsed first.
const LAPSED: &str = "SELECT a.grant_id, a.organization_id, a.not_before, a.expires_at \
     FROM grant_authority a \
     JOIN grants g ON g.id = a.grant_id AND g.organization_id = a.organization_id \
     WHERE a.organization_id = ?1 AND g.revoked_at IS NULL AND a.expires_at <= ?2 \
     ORDER BY a.expires_at DESC, a.grant_id DESC LIMIT ?3";

/// A durable authority grant's usable window, for expiry narration.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AuthorityGrantDeadline {
    pub grant_id: String,
    pub organization_id: String,
    pub not_before: DateTime<ChronoUtc>,
    pub expires_at: DateTime<ChronoUtc>,
}

impl Db {
    /// The generalized-authority sidecars one lifecycle pass collects in one
    /// organization: up to `limit` still live at `now`, soonest first, then up
    /// to `limit` that lapsed at or before `now`, most recently lapsed first.
    ///
    /// Revoked envelope grants are excluded: a withdrawn grant has no deadline
    /// worth narrating. Lapsed rows stay — the expired rung must still fire
    /// once — and nothing removes one after it has, so they only accumulate.
    /// Read in one list soonest first, a full pass of them kept every live
    /// grant out of collection: no notice while it lived, and no `expired`
    /// once it lapsed. Read apart, a live grant competes only with grants that
    /// end before it, and a lapsed one only with grants that lapsed after it.
    ///
    /// # Errors
    ///
    /// Returns an error when a query or a stored timestamp cannot be read.
    pub async fn authority_grants_expiring(
        &self,
        organization_id: &str,
        now: DateTime<ChronoUtc>,
        limit: i64,
    ) -> anyhow::Result<Vec<AuthorityGrantDeadline>> {
        let now = now.to_rfc3339();
        let mut out = Vec::new();
        for sql in [LIVE, LAPSED] {
            let rows = sqlx::query(sql)
                .bind(organization_id)
                .bind(&now)
                .bind(limit)
                .fetch_all(self.pool())
                .await?;
            for row in &rows {
                out.push(deadline(row)?);
            }
        }
        Ok(out)
    }
}

fn deadline(row: &SqliteRow) -> anyhow::Result<AuthorityGrantDeadline> {
    let not_before: String = row.try_get("not_before")?;
    let expires_at: String = row.try_get("expires_at")?;
    Ok(AuthorityGrantDeadline {
        grant_id: row.try_get("grant_id")?,
        organization_id: row.try_get("organization_id")?,
        not_before: parse_time(&not_before)?,
        expires_at: parse_time(&expires_at)?,
    })
}

fn parse_time(raw: &str) -> anyhow::Result<DateTime<ChronoUtc>> {
    DateTime::parse_from_rfc3339(raw)
        .map(|time| time.with_timezone(&ChronoUtc))
        .map_err(|error| anyhow::anyhow!("authority grant timestamp: {error}"))
}

#[cfg(test)]
#[path = "expiry_tests.rs"]
mod tests;
