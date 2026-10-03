//! The append-only audit of agent-hooks verdicts (ADR 0156, migration 0052).
//!
//! One row per answered interception, written in the request that produced
//! the verdict. It is the Host's own trail, not a change feed: it is never on
//! the outbox, so the backup actor neither drains nor snapshots it, and the
//! trail grows only as far as its retention lets it.
//!
//! The row has no field that can hold what a verdict was *about* — no tool
//! name, no target, no transform value, no message — so value-blindness is a
//! property of the schema and not of a caller's care (agent-hooks/0.1 §14).

use anyhow::Context as _;
use sqlx::{QueryBuilder, Sqlite};

use crate::{Db, Row};

/// Most rows one page returns, whatever the caller asked for.
pub const MAX_DECISION_PAGE: i64 = 200;

/// One decision to append. Borrowed: the caller already owns every value.
#[derive(Clone, Copy, Debug)]
pub struct NewAgentHookDecision<'a> {
    pub organization_id: &'a str,
    /// `operator`, or the calling session's principal.
    pub caller: &'a str,
    /// The interception point the context named; `None` when it named none of
    /// the eight (an unreadable body).
    pub interception_point: Option<&'a str>,
    /// `allow`, `deny` or `transform`.
    pub decision: &'a str,
    pub escalated: bool,
    /// A short machine identifier, or `None`. Never prose.
    pub reason: Option<&'a str>,
    pub policy_version: i64,
    /// RFC 3339, as every stored timestamp.
    pub created_at: &'a str,
}

/// One stored decision.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StoredAgentHookDecision {
    /// The pagination cursor: rises with every append.
    pub id: i64,
    pub organization_id: String,
    pub caller: String,
    pub interception_point: Option<String>,
    pub decision: String,
    pub escalated: bool,
    pub reason: Option<String>,
    pub policy_version: i64,
    pub created_at: String,
}

/// What a listing narrows to. Every field is an exact match except the two
/// bounds on `created_at`; an empty filter is the whole trail.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct AgentHookDecisionFilter {
    pub decision: Option<String>,
    pub interception_point: Option<String>,
    pub caller: Option<String>,
    pub reason: Option<String>,
    pub escalated: Option<bool>,
    pub policy_version: Option<i64>,
    /// Inclusive lower bound on `created_at`.
    pub since: Option<String>,
    /// Exclusive upper bound on `created_at`.
    pub until: Option<String>,
}

fn decision_from_row(row: &sqlx::sqlite::SqliteRow) -> StoredAgentHookDecision {
    StoredAgentHookDecision {
        id: row.get("id"),
        organization_id: row.get("organization_id"),
        caller: row.get("caller"),
        interception_point: row.get("interception_point"),
        decision: row.get("decision"),
        escalated: row.get::<i64, _>("escalated") != 0,
        reason: row.get("reason"),
        policy_version: row.get("policy_version"),
        created_at: row.get("created_at"),
    }
}

/// Append `column = value` to the filter clause when the value is present.
fn narrow<'a>(query: &mut QueryBuilder<'a, Sqlite>, clause: &'static str, value: Option<&'a str>) {
    if let Some(value) = value {
        query.push(clause).push_bind(value);
    }
}

impl Db {
    /// Append one decision.
    ///
    /// # Errors
    ///
    /// The insert fails, or the schema refuses a value (an unknown point or
    /// decision). The caller must not hand the verdict out unrecorded.
    pub async fn append_agent_hook_decision(
        &self,
        decision: &NewAgentHookDecision<'_>,
    ) -> anyhow::Result<i64> {
        let outcome = sqlx::query(
            "INSERT INTO agent_hook_decisions \
             (organization_id, caller, interception_point, decision, escalated, reason, \
              policy_version, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(decision.organization_id)
        .bind(decision.caller)
        .bind(decision.interception_point)
        .bind(decision.decision)
        .bind(i64::from(decision.escalated))
        .bind(decision.reason)
        .bind(decision.policy_version)
        .bind(decision.created_at)
        .execute(self.pool())
        .await
        .context("append agent-hook decision")?;
        Ok(outcome.last_insert_rowid())
    }

    /// The organization's decisions, newest first, `limit` at a time.
    ///
    /// `before` is the cursor: only rows with a smaller `id` are returned, so
    /// a page ends where the next begins even while rows are appended.
    /// Returns at most `limit` rows (clamped to `1..=`[`MAX_DECISION_PAGE`]).
    ///
    /// # Errors
    ///
    /// Propagates database failures.
    pub async fn list_agent_hook_decisions(
        &self,
        organization_id: &str,
        filter: &AgentHookDecisionFilter,
        before: Option<i64>,
        limit: i64,
    ) -> anyhow::Result<Vec<StoredAgentHookDecision>> {
        let mut query = QueryBuilder::<Sqlite>::new(
            "SELECT id, organization_id, caller, interception_point, decision, escalated, \
             reason, policy_version, created_at FROM agent_hook_decisions WHERE organization_id = ",
        );
        query.push_bind(organization_id);
        if let Some(before) = before {
            query.push(" AND id < ").push_bind(before);
        }
        narrow(&mut query, " AND decision = ", filter.decision.as_deref());
        narrow(
            &mut query,
            " AND interception_point = ",
            filter.interception_point.as_deref(),
        );
        narrow(&mut query, " AND caller = ", filter.caller.as_deref());
        narrow(&mut query, " AND reason = ", filter.reason.as_deref());
        narrow(&mut query, " AND created_at >= ", filter.since.as_deref());
        narrow(&mut query, " AND created_at < ", filter.until.as_deref());
        if let Some(escalated) = filter.escalated {
            query
                .push(" AND escalated = ")
                .push_bind(i64::from(escalated));
        }
        if let Some(version) = filter.policy_version {
            query.push(" AND policy_version = ").push_bind(version);
        }
        query
            .push(" ORDER BY id DESC LIMIT ")
            .push_bind(limit.clamp(1, MAX_DECISION_PAGE));
        let rows = query
            .build()
            .fetch_all(self.pool())
            .await
            .context("list agent-hook decisions")?;
        Ok(rows.iter().map(decision_from_row).collect())
    }

    /// Delete decisions older than `created_before` (RFC 3339), for every
    /// organization. Returns how many were removed.
    ///
    /// # Errors
    ///
    /// Propagates database failures.
    pub async fn purge_agent_hook_decisions(&self, created_before: &str) -> anyhow::Result<u64> {
        let outcome = sqlx::query("DELETE FROM agent_hook_decisions WHERE created_at < ?")
            .bind(created_before)
            .execute(self.pool())
            .await
            .context("purge agent-hook decisions")?;
        Ok(outcome.rows_affected())
    }
}
