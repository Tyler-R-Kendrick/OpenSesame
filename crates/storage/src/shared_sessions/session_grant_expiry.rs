//! The session grants one lifecycle pass reads (ADR 0079 §4, ADR 0074 §1).
//!
//! Split from [`crate::shared_sessions`] because it answers the scanner's
//! question rather than the fence's: not which grants authorize, but which
//! ones still owe a rung of the expiry ladder.

use anyhow::Context;
use chrono::{DateTime, Utc};
use opensesame_domain::SessionGrant;

use crate::Db;

/// Unrevoked grants still live at `?2`, soonest first.
const LIVE: &str = "SELECT * FROM session_grants \
     WHERE organization_id = ?1 AND revoked_at IS NULL AND expires_at > ?2 \
     ORDER BY expires_at ASC, id ASC LIMIT ?3";

/// Unrevoked grants that lapsed at or before `?2`, most recently lapsed first.
const LAPSED: &str = "SELECT * FROM session_grants \
     WHERE organization_id = ?1 AND revoked_at IS NULL AND expires_at <= ?2 \
     ORDER BY expires_at DESC, id DESC LIMIT ?3";

impl Db {
    /// The grants one lifecycle pass collects in one organization: up to
    /// `limit` still live at `now`, soonest first, then up to `limit` that
    /// lapsed at or before `now`, most recently lapsed first.
    ///
    /// Revoked grants are excluded: a withdrawn grant has no deadline worth
    /// narrating, and telling somebody their access expires in an hour when it
    /// ended yesterday is worse than silence.
    ///
    /// Two bounded reads, not one. A lapsed grant is neither revoked nor
    /// deleted while its session stays open, so a long-running session keeps
    /// every one, its `expired` rung already published. Read in one list
    /// soonest first, a full pass of those rows kept every live grant out of
    /// collection: no notice while it lived, and no `expired` once it lapsed.
    /// Read apart, a live grant competes only with grants that end before it,
    /// and a lapsed one only with grants that lapsed after it. Both reads walk
    /// `session_grants_expiry_idx`.
    ///
    /// # Errors
    ///
    /// Returns an error when a query or a stored row cannot be read.
    pub async fn session_grants_expiring(
        &self,
        organization_id: &str,
        now: DateTime<Utc>,
        limit: i64,
    ) -> anyhow::Result<Vec<SessionGrant>> {
        let now = now.to_rfc3339();
        let mut grants = Vec::new();
        for (sql, read) in [
            (LIVE, "select live grants"),
            (LAPSED, "select lapsed grants"),
        ] {
            let rows = sqlx::query(sql)
                .bind(organization_id)
                .bind(&now)
                .bind(limit)
                .fetch_all(&self.pool)
                .await
                .context(read)?;
            for row in &rows {
                grants.push(self.stored_grant(row).await?);
            }
        }
        Ok(grants)
    }
}

#[cfg(test)]
#[path = "session_grant_expiry_tests.rs"]
mod tests;
