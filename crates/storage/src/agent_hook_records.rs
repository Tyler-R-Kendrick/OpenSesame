//! Reading a hosted run's agent-hooks records back out (ADR 0159).
//!
//! Writing is [`Db::append_agent_hook_records`]; this is the other half, and
//! it is deliberately narrower than the table: a page of the payload-free
//! §10.3 projection by `sequence`, and a count-and-verdict summary. Neither
//! can return more than the rows hold — no message, no transform value, no
//! target — so a caller cannot widen what a run's audit discloses.

use anyhow::Context;

use crate::web_login_runs::{record_from_row, StoredAgentHookRecord};
use crate::Db;

/// Most records one page returns. A reader that falls behind pages forward
/// rather than accruing an unbounded response.
pub const HOOK_RECORD_PAGE_LIMIT: usize = 256;

/// What a run's hook records add up to. Counts only: which verdicts the run
/// met, never what they were about.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct AgentHookRecordSummary {
    /// Every record the run has.
    pub count: i64,
    pub allow: i64,
    pub deny: i64,
    pub transform: i64,
    /// Denials that carried an approval block (an escalation).
    pub escalated: i64,
    /// The last `sequence` recorded, `None` for a run with no records.
    pub last_sequence: Option<i64>,
}

impl Db {
    /// A run's hook records after `after`, in `sequence` order, at most
    /// `limit` of them (capped at [`HOOK_RECORD_PAGE_LIMIT`]).
    ///
    /// The organization is part of the key: a run id from another tenant
    /// reads as no records.
    ///
    /// # Errors
    ///
    /// Propagates database failures.
    pub async fn agent_hook_records_after(
        &self,
        organization_id: &str,
        run_id: &str,
        after: i64,
        limit: usize,
    ) -> anyhow::Result<Vec<StoredAgentHookRecord>> {
        let limit = i64::try_from(limit.clamp(1, HOOK_RECORD_PAGE_LIMIT)).unwrap_or(i64::MAX);
        let rows = sqlx::query(
            "SELECT run_id, organization_id, sequence, interception_point, decision, escalated, \
             reason, decided_by, input_identity, enforced_identity, policy_version, recorded_at \
             FROM agent_hook_records \
             WHERE organization_id = ? AND run_id = ? AND sequence > ? \
             ORDER BY sequence ASC LIMIT ?",
        )
        .bind(organization_id)
        .bind(run_id)
        .bind(after)
        .bind(limit)
        .fetch_all(self.pool())
        .await
        .context("read agent-hook records page")?;
        Ok(rows.iter().map(record_from_row).collect())
    }

    /// The count-and-verdict summary of a run's hook records.
    ///
    /// # Errors
    ///
    /// Propagates database failures.
    pub async fn agent_hook_record_summary(
        &self,
        organization_id: &str,
        run_id: &str,
    ) -> anyhow::Result<AgentHookRecordSummary> {
        let row: (i64, i64, i64, i64, i64, Option<i64>) = sqlx::query_as(
            "SELECT COUNT(*), \
             COALESCE(SUM(decision = 'allow'), 0), \
             COALESCE(SUM(decision = 'deny'), 0), \
             COALESCE(SUM(decision = 'transform'), 0), \
             COALESCE(SUM(escalated), 0), \
             MAX(sequence) \
             FROM agent_hook_records WHERE organization_id = ? AND run_id = ?",
        )
        .bind(organization_id)
        .bind(run_id)
        .fetch_one(self.pool())
        .await
        .context("summarize agent-hook records")?;
        Ok(AgentHookRecordSummary {
            count: row.0,
            allow: row.1,
            deny: row.2,
            transform: row.3,
            escalated: row.4,
            last_sequence: row.5,
        })
    }
}
