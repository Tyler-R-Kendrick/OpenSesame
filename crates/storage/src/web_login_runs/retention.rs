//! What outlives a web-login run, and what a crashed process leaves behind
//! (ADR 0076 §5, ADR 0081, ADR 0156).
//!
//! Two jobs, both owned by the gateway's actors and both defined here so the
//! SQL that decides them is beside the tables it touches:
//!
//! - **Retention.** A run's row carries an `expires_at`; when it passes, the
//!   run goes, and everything that hangs off it goes in the same transaction:
//!   its sealed log, its step queue and its hook records. `agent_hook_records`
//!   and `runner_steps` had no caller that ever removed them. Migration 0053
//!   gave the hook records the foreign key onto the run that `runner_steps`
//!   always had, so a run removed any other way takes them with it too.
//! - **Orphans.** A gateway that stops mid-run leaves an observation run open
//!   for good: nothing else writes its `closed_at`. The reaper lists runs that
//!   have been open longer than any run may last and closes them with a
//!   value-blind reason. A run a person is driving under a live lease is not
//!   an orphan — that lease has its own clock.

use anyhow::Context;
use sqlx::Row;

use crate::{Db, MAX_BLOCKED_REASON_CHARS};

/// Rows removed by one retention pass.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct WebLoginPurge {
    pub runs: u64,
    pub events: u64,
    pub steps: u64,
    pub hook_records: u64,
}

/// An observation run nobody is running any more.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StrandedRun {
    pub organization_id: String,
    pub run_id: String,
    /// The rotation job the run observed.
    pub job_id: String,
    /// The principal the run belongs to, and its relying party's origin: what
    /// a notice about the run needs, and nothing it saw.
    pub owner_principal_id: String,
    pub target_origin: String,
    pub tier: String,
    pub control_state: String,
    pub created_at: String,
}

/// Most stranded runs one reaper pass takes on; the next pass takes the rest.
pub const STRANDED_BATCH: i64 = 200;

impl Db {
    /// Remove runs past `expires_at <= now`, with their sealed logs, step
    /// queues and hook records, in one transaction.
    ///
    /// Children are deleted explicitly, though both foreign keys cascade: the
    /// cascade is invisible to a count, and the retention report says how many
    /// of each went (it also holds on a connection with foreign keys off).
    ///
    /// # Errors
    ///
    /// Propagates database failures; nothing is removed on one.
    pub async fn purge_expired_web_login_runs(&self, now: &str) -> anyhow::Result<WebLoginPurge> {
        let mut tx = self.pool().begin().await?;
        let mut purge = WebLoginPurge::default();
        for (sql, count) in [
            (
                "DELETE FROM observation_events WHERE run_id IN \
                 (SELECT id FROM observation_runs WHERE expires_at <= ?)",
                &mut purge.events,
            ),
            (
                "DELETE FROM runner_steps WHERE run_id IN \
                 (SELECT id FROM observation_runs WHERE expires_at <= ?)",
                &mut purge.steps,
            ),
            (
                "DELETE FROM agent_hook_records WHERE run_id IN \
                 (SELECT id FROM observation_runs WHERE expires_at <= ?)",
                &mut purge.hook_records,
            ),
        ] {
            *count = sqlx::query(sql)
                .bind(now)
                .execute(&mut *tx)
                .await
                .context("purge a web-login run's children")?
                .rows_affected();
        }
        purge.runs = sqlx::query("DELETE FROM observation_runs WHERE expires_at <= ?")
            .bind(now)
            .execute(&mut *tx)
            .await
            .context("purge observation runs")?
            .rows_affected();
        tx.commit().await?;
        Ok(purge)
    }

    /// Runs still open that were created before `created_before` — older than
    /// any run may last — and that no person holds under a live lease at `now`.
    ///
    /// # Errors
    ///
    /// Propagates database failures.
    pub async fn stranded_observation_runs(
        &self,
        created_before: &str,
        now: &str,
    ) -> anyhow::Result<Vec<StrandedRun>> {
        let rows = sqlx::query(
            "SELECT organization_id, id, job_id, owner_principal_id, target_origin, tier, \
             control_state, created_at \
             FROM observation_runs \
             WHERE closed_at IS NULL AND created_at < ? \
               AND NOT (control_state = 'human_driving' AND lease_expires_at > ?) \
             ORDER BY created_at ASC, id ASC LIMIT ?",
        )
        .bind(created_before)
        .bind(now)
        .bind(STRANDED_BATCH)
        .fetch_all(self.pool())
        .await
        .context("list stranded observation runs")?;
        Ok(rows
            .iter()
            .map(|row| StrandedRun {
                organization_id: row.get("organization_id"),
                run_id: row.get("id"),
                job_id: row.get("job_id"),
                owner_principal_id: row.get("owner_principal_id"),
                target_origin: row.get("target_origin"),
                tier: row.get("tier"),
                control_state: row.get("control_state"),
                created_at: row.get("created_at"),
            })
            .collect())
    }

    /// Close a stranded run: suspended (parked for a person, never resumed
    /// into), no driver, `reason` as its hint, and its steps can no longer be
    /// claimed. Returns whether this call closed it — `false` when it was
    /// already closed, or a person took it under a live lease in the meantime.
    ///
    /// # Errors
    ///
    /// Propagates database failures.
    pub async fn close_stranded_observation_run(
        &self,
        organization_id: &str,
        run_id: &str,
        reason: &str,
        now: &str,
    ) -> anyhow::Result<bool> {
        let hint: String = reason.chars().take(MAX_BLOCKED_REASON_CHARS).collect();
        let outcome = sqlx::query(
            "UPDATE observation_runs SET control_state = 'suspended', quiescence = 'quiescent', \
             handoff_queued = 0, lease_holder = NULL, lease_expires_at = NULL, \
             blocked_reason = ?, closed_at = ?, updated_at = ?, version = version + 1 \
             WHERE organization_id = ? AND id = ? AND closed_at IS NULL \
               AND NOT (control_state = 'human_driving' AND lease_expires_at > ?)",
        )
        .bind(hint)
        .bind(now)
        .bind(now)
        .bind(organization_id)
        .bind(run_id)
        .bind(now)
        .execute(self.pool())
        .await
        .context("close stranded observation run")?;
        Ok(outcome.rows_affected() == 1)
    }
}
