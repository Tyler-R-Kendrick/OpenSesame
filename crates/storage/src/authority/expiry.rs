//! Deadlines for the lifecycle scanner (ADR 0120 §5 / INV-GA-05).
//!
//! Value-blind: grant id, organization, and the interval only. No permission
//! entries, digests, or secret-shaped columns leave this query.

use chrono::{DateTime, Utc as ChronoUtc};
use sqlx::Row;

use crate::Db;

/// A durable authority grant's usable window, for expiry narration.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AuthorityGrantDeadline {
    pub grant_id: String,
    pub organization_id: String,
    pub not_before: DateTime<ChronoUtc>,
    pub expires_at: DateTime<ChronoUtc>,
}

impl Db {
    /// Live generalized-authority sidecars, soonest deadline first.
    ///
    /// Revoked envelope grants are excluded: a withdrawn grant has no deadline
    /// worth narrating. Already-expired rows stay — the expired rung must still
    /// fire once.
    ///
    /// # Errors
    ///
    /// Returns an error when the query or a stored timestamp cannot be read.
    pub async fn authority_grants_expiring(
        &self,
        organization_id: &str,
        limit: i64,
    ) -> anyhow::Result<Vec<AuthorityGrantDeadline>> {
        let rows = sqlx::query(
            "SELECT a.grant_id, a.organization_id, a.not_before, a.expires_at \
             FROM grant_authority a \
             JOIN grants g ON g.id = a.grant_id AND g.organization_id = a.organization_id \
             WHERE a.organization_id = ? AND g.revoked_at IS NULL \
             ORDER BY a.expires_at LIMIT ?",
        )
        .bind(organization_id)
        .bind(limit)
        .fetch_all(self.pool())
        .await?;
        let mut out = Vec::with_capacity(rows.len());
        for row in rows {
            let not_before: String = row.try_get("not_before")?;
            let expires_at: String = row.try_get("expires_at")?;
            out.push(AuthorityGrantDeadline {
                grant_id: row.try_get("grant_id")?,
                organization_id: row.try_get("organization_id")?,
                not_before: parse_time(&not_before)?,
                expires_at: parse_time(&expires_at)?,
            });
        }
        Ok(out)
    }
}

fn parse_time(raw: &str) -> anyhow::Result<DateTime<ChronoUtc>> {
    DateTime::parse_from_rfc3339(raw)
        .map(|time| time.with_timezone(&ChronoUtc))
        .map_err(|error| anyhow::anyhow!("authority grant timestamp: {error}"))
}
